/* Rate-limiting proxy for the Political Compass app.
 *
 * Holds the Groq key as a Worker secret so it never reaches the browser, and
 * allows one analysis per IP per RATE_WINDOW_SECONDS. One analysis is one HTTP
 * request even when the timeline needs several Groq calls.
 */

import {
  OUTPUT_TOKENS,
  PARTIAL_TOKENS,
  TooLargeError,
  buildPrompt,
  buildSynthesisPrompt,
  chunkPosts,
  entryTokenBudget,
  isReasoningModel,
  isSizeError,
  parseModelJson,
  windowLabel,
} from "../../shared/prompts.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const RATE_WINDOW_SECONDS = 600;
const MAX_POSTS = 500;
const TPM_LIMIT = 8000;

const SYSTEM_PROMPT =
  "You are a careful political-science analyst. You place an X/Twitter account on a two-axis political compass using only the posts you are given. You always answer with a single JSON object and nothing else.";

function corsHeaders(env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ok = allowed.length === 0 || allowed.includes(origin);
  return {
    ok,
    headers: {
      "Access-Control-Allow-Origin": ok ? origin || "*" : allowed[0] || "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function callGroq(env, { model, prompt, maxTokens, jsonMode = true }) {
  const payload = {
    model,
    temperature: 0.2,
    max_completion_tokens: maxTokens,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  };
  if (isReasoningModel(model)) payload.reasoning_effort = "low";
  if (jsonMode) payload.response_format = { type: "json_object" };

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.GROQ_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const message = body?.error?.message || "Groq returned " + res.status;
    if (isSizeError(res.status, message)) throw new TooLargeError("Groq: " + message);
    const failed = body?.error?.failed_generation;
    if (failed) {
      try {
        return parseModelJson(failed);
      } catch (_) {
        /* fall through */
      }
    }
    if (res.status === 400 && /json/i.test(message) && jsonMode) {
      return callGroq(env, { model, prompt, maxTokens, jsonMode: false });
    }
    throw new Error("Groq: " + message);
  }

  const choice = body?.choices?.[0] || {};
  const content = choice.message?.content;
  if (!content || !String(content).trim()) {
    if (maxTokens < 4000) {
      return callGroq(env, { model, prompt, maxTokens: Math.min(maxTokens * 2, 4000), jsonMode });
    }
    throw new Error("Groq returned an empty completion");
  }
  try {
    return parseModelJson(content);
  } catch (err) {
    if (jsonMode) return callGroq(env, { model, prompt, maxTokens, jsonMode: false });
    throw err;
  }
}

async function scoreEntries(env, { handle, model, entries, meta, partials, depth }) {
  try {
    const prompt = buildPrompt(handle, entries, meta);
    partials.push(await callGroq(env, { model, prompt, maxTokens: PARTIAL_TOKENS }));
  } catch (err) {
    if (err.tooLarge && entries.length > 1 && depth < 8) {
      const mid = Math.ceil(entries.length / 2);
      const next = { ...meta, total: Math.max(2, meta.total) };
      await scoreEntries(env, { handle, model, entries: entries.slice(0, mid), meta: next, partials, depth: depth + 1 });
      await scoreEntries(env, { handle, model, entries: entries.slice(mid), meta: next, partials, depth: depth + 1 });
      return;
    }
    throw err;
  }
}

async function analyse(env, { handle, model, posts, window }) {
  const chunks = chunkPosts(posts, entryTokenBudget(model, PARTIAL_TOKENS));

  if (chunks.length <= 1) {
    const entries = chunks[0] || [];
    try {
      const prompt = buildPrompt(handle, entries, {
        index: 1,
        total: 1,
        totalPosts: posts.length,
        window,
      });
      return { result: await callGroq(env, { model, prompt, maxTokens: OUTPUT_TOKENS }), batches: 1 };
    } catch (err) {
      if (!err.tooLarge || entries.length < 2) throw err;
    }
  }

  const partials = [];
  const total = Math.max(2, chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    await scoreEntries(env, {
      handle,
      model,
      entries: chunks[i],
      meta: { index: i + 1, total, totalPosts: posts.length, window },
      partials,
      depth: 0,
    });
  }

  const synth = buildSynthesisPrompt(handle, partials, posts.length, window);
  try {
    return {
      result: await callGroq(env, { model, prompt: synth, maxTokens: OUTPUT_TOKENS }),
      batches: chunks.length,
    };
  } catch (err) {
    if (!err.tooLarge) throw err;
    const compact = buildSynthesisPrompt(handle, partials, posts.length, window, { compact: true });
    return {
      result: await callGroq(env, { model, prompt: compact, maxTokens: OUTPUT_TOKENS }),
      batches: chunks.length,
    };
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const { ok: originOk, headers: cors } = corsHeaders(env, origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!originOk) return json({ error: "Origin not allowed" }, 403, cors);
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);

    const url = new URL(request.url);
    if (url.pathname !== "/analyse") return json({ error: "Not found" }, 404, cors);

    if (!env.GROQ_API_KEY) return json({ error: "Proxy is missing GROQ_API_KEY" }, 500, cors);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const key = "rl:" + ip;

    const seen = await env.RATE.get(key);
    if (seen) {
      const elapsed = (Date.now() - Number(seen)) / 1000;
      const retry = Math.max(1, Math.ceil(RATE_WINDOW_SECONDS - elapsed));
      return json({ error: "Rate limited", retry_after: retry }, 429, {
        ...cors,
        "Retry-After": String(retry),
      });
    }

    let payload;
    try {
      payload = await request.json();
    } catch (_) {
      return json({ error: "Invalid JSON body" }, 400, cors);
    }

    const handle = String(payload.handle || "").replace(/[^A-Za-z0-9_]/g, "");
    const model = String(payload.model || "openai/gpt-oss-20b");
    const posts = Array.isArray(payload.posts) ? payload.posts.slice(0, MAX_POSTS) : [];

    if (!handle) return json({ error: "Missing handle" }, 400, cors);
    if (!posts.length) return json({ error: "Missing posts" }, 400, cors);

    try {
      const { result, batches } = await analyse(env, {
        handle,
        model,
        posts,
        window: payload.window || windowLabel(posts),
      });
      await env.RATE.put(key, String(Date.now()), { expirationTtl: RATE_WINDOW_SECONDS });
      return json({ result, batches }, 200, cors);
    } catch (err) {
      return json({ error: err?.message || "Analysis failed" }, 502, cors);
    }
  },
};
