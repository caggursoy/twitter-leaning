/* Shared prompt and batching logic.
 * Imported by the browser client (app.js) and by the rate-limiting proxy
 * (worker/src/index.js) so both build byte-identical prompts.
 */

export const TWEET_CHAR_LIMIT = 420;
export const CHARS_PER_TOKEN = 4;
export const INPUT_TOKEN_BUDGET = 5000;
export const OUTPUT_TOKENS = 2000;
export const PARTIAL_TOKENS = 1400;

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

export function chunkPosts(posts, charBudget) {
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

export function buildPrompt(handle, entries, meta) {
  const header =
    "Account: @" + handle + "\n" +
    (meta.total > 1
      ? "Batch " + meta.index + " of " + meta.total + " — " + entries.length + " of " + meta.totalPosts + " posts\n"
      : "Posts supplied: " + entries.length + "\n") +
    "Window: " + meta.window + "\n\nPOSTS\n";
  return header + entries.map((e) => e.line).join("") + (meta.total > 1 ? PARTIAL_INSTRUCTION : FINAL_INSTRUCTION);
}

export function buildSynthesisPrompt(handle, partials, totalPosts, window) {
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

export function parseModelJson(raw) {
  let text = String(raw || "").trim();
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("Model did not return JSON");
  return JSON.parse(text.slice(start, end + 1));
}

export function estimateTokens(text) {
  return Math.ceil(String(text || "").length / CHARS_PER_TOKEN);
}

export function isReasoningModel(model) {
  return /gpt-oss|qwen3|deepseek|reason/i.test(model);
}

export function windowLabel(posts) {
  return fmtDate(posts[posts.length - 1]?.created_timestamp) + " to " + fmtDate(posts[0]?.created_timestamp);
}
