/* Political Compass — static client for GitHub Pages.
 * Data: FxTwitter read API (CORS-enabled, no key). Model: Groq chat completions.
 */

const FX_API = "https://api.fxtwitter.com";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODELS_URL = "https://api.groq.com/openai/v1/models";
const PAGE_SIZE = 100;
const MAX_PAGES = 26;
const TPM_LIMIT = 8000;
const INPUT_TOKEN_BUDGET = 5200;
const OUTPUT_TOKENS = 800;
const TWEET_CHAR_LIMIT = 420;
const CHARS_PER_TOKEN = 4;
const FALLBACK_MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"];
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

function fmtDate(unixSeconds) {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
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

function postText(post) {
  const raw = post.text || "";
  return raw.replace(/\s+/g, " ").trim();
}

function postLine(post, index) {
  let text = postText(post);
  if (text.length > TWEET_CHAR_LIMIT) text = text.slice(0, TWEET_CHAR_LIMIT) + "…";
  const kind = post.reposted_by
    ? " [repost of @" + (post.author?.screen_name || "unknown") + "]"
    : post.replying_to
    ? " [reply]"
    : "";
  return "[" + (index + 1) + "] id=" + post.id + " " + fmtDate(post.created_timestamp) + kind + "\n" + text + "\n";
}

function chunkPosts(posts, charBudget) {
  const chunks = [];
  let current = [];
  let used = 0;
  posts.forEach((post, i) => {
    const entry = { post, line: postLine(post, i) };
    if (current.length && used + entry.line.length > charBudget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(entry);
    used += entry.line.length;
  });
  if (current.length) chunks.push(current);
  return chunks;
}

const FIELD_ECON =
  "- economic: number from -1 to 1. -1 means far left (redistribution, state ownership, strong regulation); +1 means far right (free markets, low taxes, privatisation).";
const FIELD_SOCIAL =
  "- social: number from -1 to 1. -1 means libertarian (civil liberties, permissive, anti-surveillance); +1 means authoritarian (order, tradition, surveillance, restrictions).";
const JSON_ONLY_RULE =
  "Output only the JSON object. No comments, no markdown fences, no text before or after it.";

const PARTIAL_INSTRUCTION =
  "\nTask: read the tweets from this user, provide the political alignment of this user.\n\n" +
  "This is one batch of a longer timeline. Return one JSON object with exactly these keys:\n" +
  '{"economic": 0.0, "social": 0.0, "confidence": 0.0, "themes": [], "evidence": [{"tweet_id": "", "quote": "", "why": ""}], "note": ""}\n' +
  "Field meanings:\n" +
  FIELD_ECON + "\n" +
  FIELD_SOCIAL + "\n" +
  "- confidence: number from 0 to 1 for this batch alone.\n" +
  "- themes: 2 to 5 short labels seen in this batch.\n" +
  "- evidence: 1 or 2 items, each quoting a post verbatim and naming the tweet_id it came from.\n" +
  "- note: one sentence on what this batch shows.\n" +
  "Rules: use only the posts above; reposts and replies count as signal; if this batch is apolitical put both scores near 0 and confidence low; never invent quotes; tweet_id must be one of the ids listed. " +
  JSON_ONLY_RULE;

const FINAL_INSTRUCTION =
  "\nTask: read the tweets from this user, provide the political alignment of this user.\n\n" +
  "Return one JSON object with exactly these keys:\n" +
  '{"economic": 0.0, "social": 0.0, "confidence": 0.0, "summary": "", "themes": [], "evidence": [{"tweet_id": "", "quote": "", "why": ""}], "caveats": ""}\n' +
  "Field meanings:\n" +
  FIELD_ECON + "\n" +
  FIELD_SOCIAL + "\n" +
  "- confidence: number from 0 to 1, how well the posts support the placement.\n" +
  "- summary: 2 to 4 sentences on the alignment and what drives it.\n" +
  "- themes: 3 to 6 short labels, for example free markets or immigration.\n" +
  "- evidence: 3 to 6 items, each quoting a post verbatim and naming the tweet_id it came from.\n" +
  "- caveats: one or two sentences on what this reading cannot capture.\n" +
  "Rules: use only the posts above; reposts and replies count as signal; if the account is apolitical put both scores near 0 and confidence low; never invent quotes; tweet_id must be one of the ids listed. " +
  JSON_ONLY_RULE;

function buildPrompt(handle, entries, meta) {
  const header =
    "Account: @" + handle + "\n" +
    (meta.total > 1
      ? "Batch " + meta.index + " of " + meta.total + " — " + entries.length + " of " + meta.totalPosts + " posts\n"
      : "Posts supplied: " + entries.length + "\n") +
    "Window: " + meta.window + "\n\nPOSTS\n";
  return header + entries.map((e) => e.line).join("") + (meta.total > 1 ? PARTIAL_INSTRUCTION : FINAL_INSTRUCTION);
}

function buildSynthesisPrompt(handle, partials, totalPosts, window) {
  const blocks = partials.map((p, i) => {
    const themes = (p.themes || []).join(", ");
    const quotes = (p.evidence || [])
      .map((e) => "  - id=" + e.tweet_id + " \"" + String(e.quote || "").slice(0, 160) + "\"")
      .join("\n");
    return (
      "Batch " + (i + 1) + ": economic=" + p.economic + " social=" + p.social +
      " confidence=" + p.confidence + "\n" +
      "  themes: " + themes + "\n" +
      (p.note ? "  note: " + p.note + "\n" : "") +
      (quotes ? "  quotes:\n" + quotes + "\n" : "")
    );
  });

  return (
    "Account: @" + handle + "\n" +
    "The timeline was read in " + partials.length + " batches covering " + totalPosts + " posts (" + window + ").\n" +
    "Each batch was already scored on the same two axes. Merge them into one placement for the whole account.\n\n" +
    "BATCH RESULTS\n" + blocks.join("\n") +
    "\nTask: read the tweets from this user, provide the political alignment of this user.\n\n" +
    "Return one JSON object with exactly these keys:\n" +
    '{"economic": 0.0, "social": 0.0, "confidence": 0.0, "summary": "", "themes": [], "evidence": [{"tweet_id": "", "quote": "", "why": ""}], "caveats": ""}\n' +
    "Field meanings:\n" +
    FIELD_ECON + "\n" +
    FIELD_SOCIAL + "\n" +
    "- confidence: number from 0 to 1 for the merged placement.\n" +
    "- summary: 2 to 4 sentences on the alignment and what drives it.\n" +
    "- themes: 3 to 6 short labels.\n" +
    "- evidence: 3 to 6 items, reusing ids and quotes from the batches above.\n" +
    "- caveats: one or two sentences on what this reading cannot capture.\n" +
    "Rules: weight batches by their confidence; never invent quotes or ids; if the batches disagree, say so in caveats and lower confidence. " +
    JSON_ONLY_RULE
  );
}

function parseModelJson(raw) {
  let text = String(raw || "").trim();
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("Model did not return JSON");
  return JSON.parse(text.slice(start, end + 1));
}

const rate = { windowStart: 0, used: 0 };

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / CHARS_PER_TOKEN);
}

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
    max_tokens: maxTokens,
    messages: [
      {
        role: "system",
        content:
          "You are a careful political-science analyst. You place an X/Twitter account on a two-axis political compass using only the posts you are given. You always answer with a single JSON object and nothing else.",
      },
      { role: "user", content: prompt },
    ],
  };
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

  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned an empty completion");
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
  const window =
    fmtDate(posts[posts.length - 1]?.created_timestamp) + " to " + fmtDate(posts[0]?.created_timestamp);
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
    partials.push(await callGroq({ apiKey, model, prompt, maxTokens: 600 }));
  }

  onProgress?.("Merging " + chunks.length + " batches…");
  const synth = buildSynthesisPrompt(handle, partials, posts.length, window);
  return { result: await callGroq({ apiKey, model, prompt: synth }), batches: chunks.length };
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
  if (!apiKey) {
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
    const { result: raw, batches } = await analysePosts({
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
    renderReading(raw, posts, user.screen_name || handle);
    el.results.hidden = false;
    el.results.scrollIntoView({ behavior: "smooth", block: "start" });

    const note =
      posts.length < count
        ? "Only " + posts.length + " posts were available (asked for " + count + ")."
        : "Analysed " + posts.length + " posts" + (batches > 1 ? " in " + batches + " batches" : "") + ".";
    setStatus(note + " Placed in " + quadrantOf(economic, social) + ".", "ok");
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
