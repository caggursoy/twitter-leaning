/* Political Compass — static client for GitHub Pages.
 * Data: FxTwitter read API (CORS-enabled, no key). Model: Groq chat completions,
 * either directly with a user-supplied key or through the rate-limiting proxy.
 */

import {
  CHARS_PER_TOKEN,
  INPUT_TOKEN_BUDGET,
  OUTPUT_TOKENS,
  PARTIAL_TOKENS,
  buildPrompt,
  buildSynthesisPrompt,
  chunkPosts,
  estimateTokens,
  isReasoningModel,
  parseModelJson,
  windowLabel,
} from "./shared/prompts.js";

const FX_API = "https://api.fxtwitter.com";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODELS_URL = "https://api.groq.com/openai/v1/models";
const PAGE_SIZE = 100;
const MAX_PAGES = 26;
const TPM_LIMIT = 8000;
const FALLBACK_MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"];

/* Set to the deployed worker URL to run without a user-supplied key.
 * ?proxy=https://... overrides it for testing. */
const PROXY_URL =
  new URLSearchParams(location.search).get("proxy") ||
  "https://twitter-leaning-proxy.caggursoy.workers.dev";

const IDEO_SIZE = 600;
const IDEO_CELLS = 12;

const IDEOLOGY_GRID = [
  ["#b97a57", "#f79398", "#f79398", "#f79398", "#f14952", "#f14952", "#ed1c24", "#ed1c24", "#d7d700", "#d7d700", "#d7d700", "#ff7f27"],
  ["#b97a57", "#d4aa94", "#d4aa94", "#d4aa94", "#f14952", "#f14952", "#ed1c24", "#ed1c24", "#800080", "#800080", "#800080", "#ff7f27"],
  ["#b97a57", "#d4aa94", "#d4aa94", "#ffaec9", "#ffaec9", "#ff0080", "#ff0080", "#a9639b", "#a9639b", "#800080", "#800080", "#ff7f27"],
  ["#b97a57", "#d4aa94", "#ffaec9", "#ffaec9", "#ffaec9", "#ff0080", "#ff0080", "#a9639b", "#a9639b", "#a9639b", "#800080", "#ff7f27"],
  ["#e3d075", "#e3d075", "#ffaec9", "#ffaec9", "#ffaec9", "#ff0080", "#ff0080", "#a9639b", "#a9639b", "#a9639b", "#0000ff", "#0000ff"],
  ["#e3d075", "#e3d075", "#808040", "#808040", "#808040", "#99d9ea", "#99d9ea", "#00ffff", "#00ffff", "#00ffff", "#0000ff", "#0000ff"],
  ["#80ff80", "#80ff80", "#808040", "#808040", "#808040", "#99d9ea", "#99d9ea", "#00ffff", "#00ffff", "#00ffff", "#5fafaf", "#5fafaf"],
  ["#80ff80", "#80ff80", "#1b8d3d", "#1b8d3d", "#1b8d3d", "#008080", "#008080", "#004040", "#004040", "#004040", "#5fafaf", "#5fafaf"],
  ["#3eff3e", "#00ae57", "#1b8d3d", "#1b8d3d", "#1b8d3d", "#008080", "#008080", "#004040", "#004040", "#004040", "#4a4aff", "#7092be"],
  ["#3eff3e", "#00ae57", "#00ae57", "#1b8d3d", "#1b8d3d", "#008080", "#008080", "#004040", "#004040", "#4a4aff", "#4a4aff", "#7092be"],
  ["#3eff3e", "#00ae57", "#00ae57", "#00ae57", "#808000", "#808000", "#00006c", "#00006c", "#4a4aff", "#4a4aff", "#4a4aff", "#7092be"],
  ["#3eff3e", "#00350e", "#00350e", "#00350e", "#808000", "#808000", "#00006c", "#00006c", "#004080", "#004080", "#004080", "#7092be"],
];

const IDEOLOGY_NAMES = [
  ["Communism", "National Communism", "National Communism", "National Communism", "Totalitarianism", "Totalitarianism", "Nationalism", "Nationalism", "Nationalism", "Fascism", "Fascism", "Fundamentalism"],
  ["Communism", "National Socialism", "National Socialism", "National Socialism", "Totalitarianism", "Totalitarianism", "Nationalism", "Nationalism", "Nationalism", "Traditionalism", "Traditionalism", "Fundamentalism"],
  ["Communism", "National Socialism", "National Socialism", "Statism", "Statism", "Authoritarianism", "Authoritarianism", "Conservatism", "Conservatism", "Traditionalism", "Traditionalism", "Fundamentalism"],
  ["Communism", "National Socialism", "Statism", "Statism", "Statism", "Authoritarianism", "Authoritarianism", "Conservatism", "Conservatism", "Conservatism", "Capitalism", "Fundamentalism"],
  ["Socialism", "Socialism", "Statism", "Statism", "Statism", "Authoritarianism", "Authoritarianism", "Conservatism", "Conservatism", "Conservatism", "Capitalism", "Capitalism"],
  ["Socialism", "Socialism", "Social Democracy", "Social Democracy", "Social Democracy", "Liberalism", "Liberalism", "Progressivism", "Progressivism", "Progressivism", "Capitalism", "Capitalism"],
  ["Democratic Socialism", "Democratic Socialism", "Social Democracy", "Social Democracy", "Social Democracy", "Liberalism", "Liberalism", "Progressivism", "Progressivism", "Progressivism", "Libertarian Capitalism", "Libertarian Capitalism"],
  ["Democratic Socialism", "Democratic Socialism", "Libertarian Socialism", "Libertarian Socialism", "Libertarian Socialism", "Activism", "Activism", "Libertarianism", "Libertarianism", "Libertarianism", "Libertarian Capitalism", "Libertarian Capitalism"],
  ["Anarcho-Communism", "Anarcho-Socialism", "Libertarian Socialism", "Libertarian Socialism", "Libertarian Socialism", "Activism", "Activism", "Libertarianism", "Libertarianism", "Libertarianism", "Individualism", "Anarcho-Capitalism"],
  ["Anarcho-Communism", "Anarcho-Socialism", "Anarcho-Socialism", "Libertarian Socialism", "Libertarian Socialism", "Activism", "Activism", "Libertarianism", "Libertarianism", "Individualism", "Individualism", "Anarcho-Capitalism"],
  ["Anarcho-Communism", "Anarcho-Socialism", "Anarcho-Socialism", "Anarcho-Socialism", "Syndicalism", "Syndicalism", "Mutualism", "Mutualism", "Individualism", "Individualism", "Individualism", "Anarcho-Capitalism"],
  ["Anarcho-Communism", "Anarcho-Collectivism", "Anarcho-Collectivism", "Anarcho-Collectivism", "Syndicalism", "Syndicalism", "Mutualism", "Mutualism", "Anarchism", "Anarchism", "Anarchism", "Anarcho-Capitalism"],
];

const IDEOLOGY_LABELS = [
  { t: "Communism", x: 0.56, y: 2.0, rot: true },
  { t: "National\nCommunism", x: 2.5, y: 0.55 },
  { t: "National\nSocialism", x: 2.5, y: 1.6 },
  { t: "Totalita-\nrianism", x: 4.5, y: 0.9 },
  { t: "Nationalism", x: 7.0, y: 0.9 },
  { t: "Fascism", x: 9.5, y: 0.5 },
  { t: "Fundamentalism", x: 11.44, y: 1.5, rot: true },
  { t: "Traditio-\nnalism", x: 9.5, y: 1.6 },
  { t: "Statism", x: 3.5, y: 2.9 },
  { t: "Authorit-\narianism", x: 5.5, y: 2.85 },
  { t: "Conser-\nvatism", x: 7.5, y: 2.85 },
  { t: "Socialism", x: 1.0, y: 3.5 },
  { t: "Capitalism", x: 10.5, y: 3.5 },
  { t: "Social\nDemocracy", x: 2.5, y: 4.6 },
  { t: "Liberalism", x: 4.5, y: 4.75 },
  { t: "Progres-\nsivism", x: 7.0, y: 4.75 },
  { t: "Democratic\nSocialism", x: 1.0, y: 5.6 },
  { t: "Libertarian\nCapitalism", x: 10.5, y: 5.6 },
  { t: "Libertarian\nSocialism", x: 2.5, y: 6.6 },
  { t: "Activism", x: 4.5, y: 6.75 },
  { t: "Liberta-\nrianism", x: 7.0, y: 6.6 },
  { t: "Anarcho-\nCommunism", x: 0.6, y: 8.5, rot: true },
  { t: "Anarcho-\nSocialism", x: 1.5, y: 8.6 },
  { t: "Syndicalism", x: 3.5, y: 9.75 },
  { t: "Mutualism", x: 5.5, y: 9.75 },
  { t: "Individ-\nualism", x: 8.5, y: 9.6 },
  { t: "Anarcho-\nCapitalism", x: 11.4, y: 9.0, rot: true },
  { t: "Anarcho-\nCollectivism", x: 1.5, y: 10.6 },
  { t: "Anarchism", x: 8.0, y: 10.75 },
];
const STORE = {
  key: "pc.groqKey",
  handle: "pc.handle",
  count: "pc.count",
  model: "pc.model",
  replies: "pc.withReplies",
  remember: "pc.remember",
};

const el = {
  handle: document.getElementById("handle"),
  count: document.getElementById("count"),
  model: document.getElementById("model"),
  loadModels: document.getElementById("loadModels"),
  modelHint: document.getElementById("modelHint"),
  apiKey: document.getElementById("apiKey"),
  withReplies: document.getElementById("withReplies"),
  rememberKey: document.getElementById("rememberKey"),
  run: document.getElementById("run"),
  reset: document.getElementById("reset"),
  status: document.getElementById("status"),
  statusText: document.querySelector("#status .status-text"),
  results: document.getElementById("results"),
  avatar: document.getElementById("avatar"),
  displayName: document.getElementById("displayName"),
  verifiedBadge: document.getElementById("verifiedBadge"),
  profileLink: document.getElementById("profileLink"),
  profileStats: document.getElementById("profileStats"),
  sampleCount: document.getElementById("sampleCount"),
  quadrantBadge: document.getElementById("quadrantBadge"),
  ideologyBadge: document.getElementById("ideologyBadge"),
  ideoMarker: document.getElementById("ideoMarker"),
  marker: document.getElementById("marker"),
  econScore: document.getElementById("econScore"),
  socialScore: document.getElementById("socialScore"),
  confidenceScore: document.getElementById("confidenceScore"),
  econFill: document.getElementById("econFill"),
  socialFill: document.getElementById("socialFill"),
  confidenceFill: document.getElementById("confidenceFill"),
  summary: document.getElementById("summary"),
  themes: document.getElementById("themes"),
  evidence: document.getElementById("evidence"),
  caveats: document.getElementById("caveats"),
};

let busy = false;

/* ---------------- small helpers ---------------- */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtNum(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function setStatus(text, tone = "idle") {
  el.status.dataset.tone = tone;
  el.statusText.textContent = text;
}

function setBusy(state) {
  busy = state;
  el.run.disabled = state;
  el.run.classList.toggle("is-busy", state);
}

function normalizeHandle(raw) {
  let h = String(raw || "").trim();
  h = h.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "");
  h = h.replace(/[?#].*$/, "").replace(/\/+$/, "");
  h = h.replace(/^@+/, "");
  h = h.split("/")[0];
  return h.replace(/[^A-Za-z0-9_]/g, "");
}

/* ---------------- FxTwitter access ---------------- */

async function fxGet(path, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(FX_API + path, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (res.status === 404) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.message || "Not found");
        err.code = 404;
        throw err;
      }
      if (res.status === 429 || res.status >= 500) {
        throw new Error("FxTwitter is rate limiting (" + res.status + ")");
      }
      if (!res.ok) throw new Error("FxTwitter returned " + res.status);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (err.code === 404) throw err;
      if (attempt < retries) await sleep(600 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function fetchFeedXml(handle) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const url =
      "https://fxtwitter.com/" +
      encodeURIComponent(handle) +
      "/feed.xml?count=100&cb=" +
      Date.now() +
      attempt;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error("Feed returned " + res.status);
      const xml = await res.text();
      const doc = new DOMParser().parseFromString(xml, "text/xml");
      if (doc.querySelector("parsererror")) throw new Error("Feed was not valid XML");
      return Array.from(doc.querySelectorAll("item")).map((item) => ({
        title: item.querySelector("title")?.textContent || "",
        link: item.querySelector("link")?.textContent || "",
        guid: item.querySelector("guid")?.textContent || "",
        date: item.querySelector("pubDate")?.textContent || "",
      }));
    } catch (err) {
      lastErr = err;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

function statusIdFromUrl(url) {
  const m = String(url || "").match(/status\/(\d+)/);
  return m ? m[1] : "";
}

/* Resolve a handle to a numeric user id plus profile fields.
 * The profile endpoint is intermittently 404, so fall back to the RSS feed:
 * take an original post by the account, then read its author from the status API. */
async function resolveUser(handle) {
  try {
    const data = await fxGet("/2/profile/" + encodeURIComponent(handle), { retries: 1 });
    if (data && data.user && data.user.id) return data.user;
  } catch (err) {
    if (err.code !== 404) throw err;
  }

  const items = await fetchFeedXml(handle);
  if (!items.length) throw new Error("No public posts found for @" + handle);

  const own = items.filter((it) =>
    new RegExp("x\\.com/" + handle + "/status/", "i").test(it.link)
  );
  const candidates = (own.length ? own : items).slice(0, 4);

  for (const item of candidates) {
    const id = statusIdFromUrl(item.link) || statusIdFromUrl(item.guid);
    if (!id) continue;
    try {
      const data = await fxGet("/2/status/" + id, { retries: 1 });
      const author = data && data.status && data.status.author;
      if (author && author.id) return author;
    } catch (_) {
      /* try the next candidate */
    }
  }
  throw new Error("Could not resolve @" + handle + " to an account id");
}

async function fetchTimeline(userId, target, { withReplies, onProgress }) {
  const collected = [];
  const seen = new Set();
  let cursor = null;

  for (let page = 0; page < MAX_PAGES && collected.length < target; page++) {
    let path =
      "/2/profile/id:" +
      encodeURIComponent(userId) +
      "/statuses?count=" +
      PAGE_SIZE +
      (withReplies ? "&with_replies=true" : "");
    if (cursor) path += "&cursor=" + encodeURIComponent(cursor);

    const data = await fxGet(path, { retries: 2 });
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) break;

    for (const post of results) {
      if (!post || !post.id || seen.has(post.id)) continue;
      if (!withReplies && post.replying_to) continue;
      seen.add(post.id);
      collected.push(post);
    }

    onProgress?.(collected.length, target);

    const next = data.cursor && data.cursor.bottom;
    if (!next || next === cursor) break;
    cursor = next;
  }

  collected.sort((a, b) => (b.created_timestamp || 0) - (a.created_timestamp || 0));
  return collected.slice(0, target);
}

/* ---------------- prompt + model ---------------- */

/* postText, postLine, chunkPosts, buildPrompt, buildSynthesisPrompt and
 * parseModelJson live in shared/prompts.js so the proxy builds identical prompts. */

const rate = { windowStart: 0, used: 0 };

async function pace(tokensNeeded) {
  const now = Date.now();
  if (!rate.windowStart || now - rate.windowStart > 60000) {
    rate.windowStart = now;
    rate.used = 0;
  }
  if (rate.used + tokensNeeded > TPM_LIMIT) {
    await sleep(60000 - (now - rate.windowStart) + 400);
    rate.windowStart = Date.now();
    rate.used = 0;
  }
  rate.used += tokensNeeded;
}

async function callGroq({ apiKey, model, prompt, maxTokens = OUTPUT_TOKENS, retries = 1, jsonMode = true }) {
  await pace(estimateTokens(prompt) + maxTokens);

  const payload = {
    model,
    temperature: 0.2,
    max_completion_tokens: maxTokens,
    messages: [
      {
        role: "system",
        content:
          "You are a careful political-science analyst. You place an X/Twitter account on a two-axis political compass using only the posts you are given. You always answer with a single JSON object and nothing else.",
      },
      { role: "user", content: prompt },
    ],
  };
  if (isReasoningModel(model)) payload.reasoning_effort = "low";
  if (jsonMode) payload.response_format = { type: "json_object" };

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => null);

  if (res.status === 429 && retries > 0) {
    const retryAfter = parseFloat(res.headers.get("retry-after") || "0");
    await sleep(Math.max(1500, (isFinite(retryAfter) ? retryAfter : 0) * 1000));
    rate.windowStart = 0;
    rate.used = 0;
    return callGroq({ apiKey, model, prompt, maxTokens, retries: retries - 1, jsonMode });
  }

  if (!res.ok) {
    const message = body?.error?.message || "Groq returned " + res.status;
    const failed = body?.error?.failed_generation;
    if (failed && retries > 0) {
      try {
        return parseModelJson(failed);
      } catch (_) {
        /* fall through to the plain-text retry */
      }
    }
    if (res.status === 400 && retries > 0 && /json/i.test(message)) {
      return callGroq({ apiKey, model, prompt, maxTokens, retries: retries - 1, jsonMode: false });
    }
    if (res.status === 401) throw new Error("Groq rejected the API key (401). Check the key and try again.");
    if (res.status === 429) {
      throw new Error("Groq rate limit hit (429) even after waiting. Try again in a minute, or lower the post count.");
    }
    if (res.status === 404 || /does not exist|do not have access/i.test(message)) {
      throw new Error("This key cannot use " + model + ". Press “Load models” to pick one it can use.");
    }
    throw new Error("Groq error: " + message);
  }

  const choice = body?.choices?.[0] || {};
  const content = choice.message?.content;
  const finish = choice.finish_reason;
  const reasoningTokens = body?.usage?.completion_tokens_details?.reasoning_tokens;

  if (!content || !String(content).trim()) {
    if (retries > 0) {
      const bigger = Math.min(maxTokens * 2, 4000);
      return callGroq({ apiKey, model, prompt, maxTokens: bigger, retries: retries - 1, jsonMode });
    }
    const detail =
      finish === "length"
        ? " the model spent all " + maxTokens + " tokens thinking" +
          (reasoningTokens ? " (" + reasoningTokens + " reasoning tokens)" : "") +
          " and never wrote an answer"
        : " the response had no content";
    throw new Error("Groq returned an empty completion:" + detail + ". Try a smaller post count or another model.");
  }

  try {
    return parseModelJson(content);
  } catch (err) {
    if (retries > 0) {
      return callGroq({ apiKey, model, prompt, maxTokens, retries: retries - 1, jsonMode: false });
    }
    throw err;
  }
}

async function analysePosts({ apiKey, model, handle, posts, onProgress }) {
  const window = windowLabel(posts);
  const chunks = chunkPosts(posts, INPUT_TOKEN_BUDGET * CHARS_PER_TOKEN);

  if (chunks.length <= 1) {
    onProgress?.("Asking " + model + " to place the account…");
    const prompt = buildPrompt(handle, chunks[0] || [], {
      index: 1,
      total: 1,
      totalPosts: posts.length,
      window,
    });
    return { result: await callGroq({ apiKey, model, prompt }), batches: 1 };
  }

  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.("Analysing batch " + (i + 1) + " of " + chunks.length + "…");
    const prompt = buildPrompt(handle, chunks[i], {
      index: i + 1,
      total: chunks.length,
      totalPosts: posts.length,
      window,
    });
    partials.push(await callGroq({ apiKey, model, prompt, maxTokens: PARTIAL_TOKENS }));
  }

  onProgress?.("Merging " + chunks.length + " batches…");
  const synth = buildSynthesisPrompt(handle, partials, posts.length, window);
  return { result: await callGroq({ apiKey, model, prompt: synth }), batches: chunks.length };
}

async function analyseViaProxy({ model, handle, posts, onProgress }) {
  onProgress?.("Sending " + posts.length + " posts to the proxy…");
  const res = await fetch(PROXY_URL.replace(/\/$/, "") + "/analyse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      handle,
      model,
      window: windowLabel(posts),
      posts: posts.map((p) => ({
        id: p.id,
        text: p.text,
        created_timestamp: p.created_timestamp,
        replying_to: p.replying_to || null,
        author: p.author ? { screen_name: p.author.screen_name } : null,
        reposted_by: p.reposted_by ? { screen_name: p.reposted_by.screen_name } : null,
      })),
    }),
  });

  const body = await res.json().catch(() => null);

  if (res.status === 429) {
    const wait = Number(body?.retry_after) || 0;
    const mins = Math.ceil(wait / 60);
    throw new Error(
      "Rate limited. One analysis per 10 minutes — try again in " + (mins > 0 ? mins + " min" : wait + "s") + "."
    );
  }
  if (!res.ok) {
    throw new Error(body?.error || "Proxy returned " + res.status);
  }
  if (!body || !body.result) throw new Error("Proxy returned no result");
  return { result: body.result, batches: body.batches || 1 };
}

function isChatModel(id) {
  return !/whisper|guard|tts|embed|moderation|safeguard/i.test(id);
}

async function loadModels(apiKey) {
  const res = await fetch(MODELS_URL, {
    headers: { Authorization: "Bearer " + apiKey },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? "Groq rejected the API key (401)."
        : "Could not list models (" + res.status + ")."
    );
  }
  const body = await res.json();
  return (body.data || []).map((m) => m.id).filter(isChatModel).sort();
}

function populateModels(ids, preferred) {
  const list = ids.length ? ids : FALLBACK_MODELS;
  const keep = preferred || el.model.value;
  el.model.innerHTML = "";
  for (const id of list) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    el.model.appendChild(option);
  }
  el.model.value = list.includes(keep) ? keep : list[0];
  return el.model.value;
}

/* ---------------- rendering ---------------- */

function quadrantOf(economic, social) {
  if (social >= 0) return economic < 0 ? "Authoritarian Left" : "Authoritarian Right";
  return economic < 0 ? "Libertarian Left" : "Libertarian Right";
}

function signed(n) {
  const v = n.toFixed(2);
  return n > 0 ? "+" + v : v;
}

function renderProfile(user, handle, sampleSize) {
  const name = user.name || handle;
  el.displayName.textContent = name;
  el.avatar.src = user.avatar_url || "";
  el.avatar.alt = name ? name + " avatar" : "";
  el.profileLink.textContent = "@" + (user.screen_name || handle);
  el.profileLink.href = "https://x.com/" + (user.screen_name || handle);
  el.verifiedBadge.hidden = !user.verification?.verified;

  const stats = [];
  if (typeof user.followers === "number") stats.push(fmtNum(user.followers) + " followers");
  if (typeof user.following === "number") stats.push(fmtNum(user.following) + " following");
  el.profileStats.textContent = stats.join(" · ");
  el.sampleCount.textContent = String(sampleSize);
}

function renderCompass(economic, social, confidence) {
  const x = 280 + clamp(economic, -1, 1) * 220;
  const y = 280 - clamp(social, -1, 1) * 220;
  el.marker.setAttribute("transform", "translate(" + x.toFixed(1) + " " + y.toFixed(1) + ")");

  el.econScore.textContent = signed(economic);
  el.socialScore.textContent = signed(social);
  el.confidenceScore.textContent = Math.round(confidence * 100) + "%";
  el.econFill.style.width = ((clamp(economic, -1, 1) + 1) / 2) * 100 + "%";
  el.socialFill.style.width = ((clamp(social, -1, 1) + 1) / 2) * 100 + "%";
  el.confidenceFill.style.width = clamp(confidence, 0, 1) * 100 + "%";
  el.quadrantBadge.textContent = quadrantOf(economic, social);
}

function buildIdeologyGrid() {
  const NS = "http://www.w3.org/2000/svg";
  const grid = document.getElementById("ideoGrid");
  const labels = document.getElementById("ideoLabels");
  if (!grid || !labels || grid.childElementCount) return;

  const cell = IDEO_SIZE / IDEO_CELLS;

  for (let r = 0; r < IDEO_CELLS; r++) {
    for (let c = 0; c < IDEO_CELLS; c++) {
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", String(c * cell));
      rect.setAttribute("y", String(r * cell));
      rect.setAttribute("width", String(cell));
      rect.setAttribute("height", String(cell));
      rect.setAttribute("fill", IDEOLOGY_GRID[r][c]);
      rect.setAttribute("class", "ideo-cell");
      grid.appendChild(rect);
    }
  }

  const border = document.createElementNS(NS, "rect");
  border.setAttribute("x", "0.75");
  border.setAttribute("y", "0.75");
  border.setAttribute("width", String(IDEO_SIZE - 1.5));
  border.setAttribute("height", String(IDEO_SIZE - 1.5));
  border.setAttribute("fill", "none");
  border.setAttribute("stroke", "#000");
  border.setAttribute("stroke-width", "1.5");
  grid.appendChild(border);

  for (const label of IDEOLOGY_LABELS) {
    const text = document.createElementNS(NS, "text");
    const cx = label.x * cell;
    const cy = label.y * cell;
    text.setAttribute("x", String(cx));
    text.setAttribute("y", String(cy));
    if (label.rot) {
      text.setAttribute("transform", "rotate(-90 " + cx + " " + cy + ")");
      text.setAttribute("font-size", "12");
    }

    const lines = label.t.split("\n");
    const lineHeight = label.rot ? 14 : 15;
    lines.forEach((line, i) => {
      const tspan = document.createElementNS(NS, "tspan");
      tspan.setAttribute("x", String(cx));
      tspan.setAttribute("dy", i === 0 ? String(-((lines.length - 1) * lineHeight) / 2) : String(lineHeight));
      tspan.textContent = line;
      text.appendChild(tspan);
    });
    labels.appendChild(text);
  }
}

function ideologyAt(economic, social) {
  const e = clamp(economic, -1, 1);
  const s = clamp(social, -1, 1);
  const col = clamp(Math.floor(((e + 1) / 2) * IDEO_CELLS), 0, IDEO_CELLS - 1);
  const row = clamp(Math.floor(((1 - s) / 2) * IDEO_CELLS), 0, IDEO_CELLS - 1);
  return { col, row, name: IDEOLOGY_NAMES[row][col] };
}

function renderIdeology(economic, social) {
  const x = ((clamp(economic, -1, 1) + 1) / 2) * IDEO_SIZE;
  const y = ((1 - clamp(social, -1, 1)) / 2) * IDEO_SIZE;
  el.ideoMarker.setAttribute("transform", "translate(" + x.toFixed(1) + " " + y.toFixed(1) + ")");
  const cell = ideologyAt(economic, social);
  el.ideologyBadge.textContent = cell.name;
  return cell;
}

function renderReading(result, posts, handle) {
  el.summary.textContent = result.summary || "No summary returned.";

  el.themes.innerHTML = "";
  for (const theme of (result.themes || []).slice(0, 8)) {
    const li = document.createElement("li");
    li.textContent = String(theme);
    el.themes.appendChild(li);
  }
  if (!el.themes.children.length) {
    const li = document.createElement("li");
    li.textContent = "none returned";
    el.themes.appendChild(li);
  }

  el.evidence.innerHTML = "";
  const byId = new Map(posts.map((p) => [String(p.id), p]));
  for (const item of (result.evidence || []).slice(0, 6)) {
    const li = document.createElement("li");
    const quote = document.createElement("blockquote");
    quote.textContent = "“" + String(item.quote || "").trim() + "”";
    li.appendChild(quote);

    if (item.why) {
      const why = document.createElement("p");
      why.className = "why";
      why.textContent = String(item.why);
      li.appendChild(why);
    }

    const post = byId.get(String(item.tweet_id));
    if (post) {
      const link = document.createElement("a");
      link.href = post.url || "https://x.com/" + handle + "/status/" + post.id;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "view post ↗";
      li.appendChild(link);
    }
    el.evidence.appendChild(li);
  }
  if (!el.evidence.children.length) {
    const li = document.createElement("li");
    li.textContent = "No evidence quotes returned.";
    el.evidence.appendChild(li);
  }

  el.caveats.textContent = result.caveats || "No caveats returned.";
}

/* ---------------- main flow ---------------- */

async function run() {
  if (busy) return;

  const handle = normalizeHandle(el.handle.value);
  const count = clamp(parseInt(el.count.value, 10) || 100, 10, 500);
  const model = el.model.value;
  const apiKey = el.apiKey.value.trim();
  const withReplies = el.withReplies.checked;

  el.handle.value = handle;
  el.count.value = String(count);

  if (!handle) {
    setStatus("Enter an X account handle first.", "err");
    el.handle.focus();
    return;
  }
  if (!PROXY_URL && !apiKey) {
    setStatus("Enter your Groq API key. It is free at console.groq.com/keys.", "err");
    el.apiKey.focus();
    return;
  }

  persistSettings();

  setBusy(true);
  el.results.hidden = true;

  try {
    setStatus("Resolving @" + handle + "…", "busy");
    const user = await resolveUser(handle);

    setStatus("Reading posts from @" + (user.screen_name || handle) + "…", "busy");
    const posts = await fetchTimeline(user.id, count, {
      withReplies,
      onProgress: (got, want) =>
        setStatus("Reading posts… " + got + " of " + want, "busy"),
    });

    if (!posts.length) throw new Error("No public posts returned for @" + handle);

    setStatus("Asking " + model + " to place the account…", "busy");
    const { result: raw, batches } = PROXY_URL
      ? await analyseViaProxy({
          model,
          handle: user.screen_name || handle,
          posts,
          onProgress: (msg) => setStatus(msg, "busy"),
        })
      : await analysePosts({
          apiKey,
          model,
          handle: user.screen_name || handle,
          posts,
          onProgress: (msg) => setStatus(msg, "busy"),
        });

    const economic = clamp(Number(raw.economic), -1, 1);
    const social = clamp(Number(raw.social), -1, 1);
    if (!isFinite(economic) || !isFinite(social)) {
      throw new Error("Model returned scores that are not numbers");
    }
    const confidence = clamp(Number(raw.confidence) || 0, 0, 1);

    renderProfile(user, handle, posts.length);
    renderCompass(economic, social, confidence);
    const cell = renderIdeology(economic, social);
    renderReading(raw, posts, user.screen_name || handle);
    el.results.hidden = false;
    el.results.scrollIntoView({ behavior: "smooth", block: "start" });

    const note =
      posts.length < count
        ? "Only " + posts.length + " posts were available (asked for " + count + ")."
        : "Analysed " + posts.length + " posts" + (batches > 1 ? " in " + batches + " batches" : "") + ".";
    setStatus(
      note + " Placed in " + quadrantOf(economic, social) + " · " + cell.name + ".",
      "ok"
    );
  } catch (err) {
    setStatus(err?.message || "Something went wrong.", "err");
  } finally {
    setBusy(false);
  }
}

/* ---------------- settings persistence ---------------- */

function persistSettings() {
  try {
    localStorage.setItem(STORE.handle, el.handle.value);
    localStorage.setItem(STORE.count, el.count.value);
    localStorage.setItem(STORE.model, el.model.value);
    localStorage.setItem(STORE.replies, String(el.withReplies.checked));
    localStorage.setItem(STORE.remember, String(el.rememberKey.checked));
    if (el.rememberKey.checked) localStorage.setItem(STORE.key, el.apiKey.value.trim());
    else localStorage.removeItem(STORE.key);
  } catch (_) {
    /* storage can be blocked; the app still works for this session */
  }
}

function restoreSettings() {
  try {
    const handle = localStorage.getItem(STORE.handle);
    if (handle) el.handle.value = handle;
    const count = localStorage.getItem(STORE.count);
    if (count) el.count.value = count;
    const model = localStorage.getItem(STORE.model);
    if (model) el.model.value = model;
    el.withReplies.checked = localStorage.getItem(STORE.replies) === "true";
    const remember = localStorage.getItem(STORE.remember);
    el.rememberKey.checked = remember === null ? true : remember === "true";
    const key = localStorage.getItem(STORE.key);
    if (key && el.rememberKey.checked) el.apiKey.value = key;
  } catch (_) {
    /* ignore */
  }
}

/* ---------------- wiring ---------------- */

el.run.addEventListener("click", run);

el.loadModels.addEventListener("click", async () => {
  const apiKey = el.apiKey.value.trim();
  if (!apiKey) {
    setStatus("Enter your Groq API key first, then load the models it can use.", "err");
    el.apiKey.focus();
    return;
  }
  el.loadModels.disabled = true;
  el.modelHint.textContent = "Loading…";
  try {
    const ids = await loadModels(apiKey);
    const chosen = populateModels(ids, el.model.value);
    el.modelHint.textContent = ids.length + " chat models available.";
    setStatus("Loaded " + ids.length + " models. Using " + chosen + ".", "ok");
    persistSettings();
  } catch (err) {
    el.modelHint.textContent = "Could not load models.";
    setStatus(err?.message || "Could not load models.", "err");
  } finally {
    el.loadModels.disabled = false;
  }
});

el.reset.addEventListener("click", () => {
  el.results.hidden = true;
  setStatus("Ready.", "idle");
});

el.handle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") run();
});

el.apiKey.addEventListener("keydown", (e) => {
  if (e.key === "Enter") run();
});

el.rememberKey.addEventListener("change", () => {
  if (!el.rememberKey.checked) {
    try {
      localStorage.removeItem(STORE.key);
    } catch (_) {
      /* ignore */
    }
  }
});

restoreSettings();
buildIdeologyGrid();

if (PROXY_URL) {
  const keyField = el.apiKey.closest(".field");
  if (keyField) keyField.hidden = true;
  el.modelHint.textContent = "Shared key via proxy · 1 analysis per 10 min.";
}
