/* Shared prompt and batching logic.
 * Imported by the browser client (app.js) and by the rate-limiting proxy
 * (worker/src/index.js) so both build byte-identical prompts.
 */

export const TWEET_CHAR_LIMIT = 420;
export const CHARS_PER_TOKEN = 4;
export const OUTPUT_TOKENS = 2000;
export const PARTIAL_TOKENS = 1400;

/* Free tier allows 8,000 tokens per minute, so input plus output has to stay under it. */
export const TPM_LIMIT = 8000;
export const TPM_INPUT_BUDGET = 5000;

/* Tokens reserved for the instruction block appended to every prompt. */
const INSTRUCTION_TOKENS = 520;

export class TooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = "TooLargeError";
    this.tooLarge = true;
  }
}

/* Groq answers 400 with one of these when input + max_tokens exceeds the context
 * window, and 413 when the body is too big. */
export function isSizeError(status, message) {
  if (status === 413) return true;
  if (status !== 400) return false;
  return /context|too large|too long|reduce the length|maximum context|tokens per minute|TPM|requested .* tokens/i.test(
    String(message || "")
  );
}

export function contextWindow(model) {
  const id = String(model || "");
  if (/gpt-oss/i.test(id)) return 131072;
  if (/llama-3\.3-70b/i.test(id)) return 131072;
  if (/llama-3\.1-8b/i.test(id)) return 131072;
  if (/qwen/i.test(id)) return 32768;
  return 32768;
}

/* Input tokens allowed for one request: the smaller of the TPM share and what the
 * context window leaves after the requested output. */
export function inputTokenBudget(model, maxOutput = PARTIAL_TOKENS) {
  const byContext = contextWindow(model) - maxOutput - 1024;
  return Math.max(1200, Math.min(TPM_INPUT_BUDGET, byContext));
}

/* Budget for the post lines themselves, after reserving the instruction block. */
export function entryTokenBudget(model, maxOutput = PARTIAL_TOKENS) {
  return Math.max(600, inputTokenBudget(model, maxOutput) - INSTRUCTION_TOKENS);
}

export function fmtDate(unixSeconds) {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function postText(post) {
  const raw = post.text || "";
  return raw.replace(/\s+/g, " ").trim();
}

export function postLine(post, index) {
  let text = postText(post);
  if (text.length > TWEET_CHAR_LIMIT) text = text.slice(0, TWEET_CHAR_LIMIT) + "...";
  const kind = post.reposted_by
    ? " [repost of @" + (post.author?.screen_name || "unknown") + "]"
    : post.replying_to
    ? " [reply]"
    : "";
  return "[" + (index + 1) + "] id=" + post.id + " " + fmtDate(post.created_timestamp) + kind + "\n" + text + "\n";
}

/* Conservative token estimate. Prose runs about four characters per token, but
 * digits, URLs and non-ASCII text tokenise far worse, so they are counted
 * separately rather than assuming a flat ratio. */
export function estimateTokens(text) {
  const s = String(text || "");
  if (!s) return 0;
  let ascii = 0;
  let digits = 0;
  let other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 128) {
      if (c >= 48 && c <= 57) digits++;
      else ascii++;
    } else {
      other++;
    }
  }
  return Math.ceil(ascii / 4 + digits / 2 + other / 1.5);
}

/* Split posts into batches that fit a token budget. A non-finite or absurd
 * budget falls back to a safe default instead of collapsing into one batch. */
export function chunkPosts(posts, tokenBudget) {
  const budget =
    Number.isFinite(tokenBudget) && tokenBudget > 200 ? tokenBudget : TPM_INPUT_BUDGET - INSTRUCTION_TOKENS;

  const chunks = [];
  let current = [];
  let used = 0;

  posts.forEach((post, i) => {
    const entry = { post, line: postLine(post, i) };
    const cost = estimateTokens(entry.line) + 4;
    if (current.length && used + cost > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(entry);
    used += cost;
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

export function buildPrompt(handle, entries, meta) {
  const header =
    "Account: @" + handle + "\n" +
    (meta.total > 1
      ? "Batch " + meta.index + " of " + meta.total + " — " + entries.length + " of " + meta.totalPosts + " posts\n"
      : "Posts supplied: " + entries.length + "\n") +
    "Window: " + meta.window + "\n\nPOSTS\n";
  return header + entries.map((e) => e.line).join("") + (meta.total > 1 ? PARTIAL_INSTRUCTION : FINAL_INSTRUCTION);
}

export function buildSynthesisPrompt(handle, partials, totalPosts, window, opts = {}) {
  const blocks = partials.map((p, i) => {
    const themes = (p.themes || []).join(", ");
    const quotes = opts.compact
      ? ""
      : (p.evidence || [])
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

export function parseModelJson(raw) {
  let text = String(raw || "").trim();
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("Model did not return JSON");
  return JSON.parse(text.slice(start, end + 1));
}

export function isReasoningModel(model) {
  return /gpt-oss|qwen3|deepseek|reason/i.test(model);
}

export function windowLabel(posts) {
  return fmtDate(posts[posts.length - 1]?.created_timestamp) + " to " + fmtDate(posts[0]?.created_timestamp);
}
