import {
  OUTPUT_TOKENS,
  PARTIAL_TOKENS,
  buildPrompt,
  chunkPosts,
  entryTokenBudget,
  estimateTokens,
  inputTokenBudget,
  windowLabel,
} from "../../shared/prompts.js";

function makePosts(n, kind) {
  return Array.from({ length: n }, (_, i) => {
    const base = {
      id: String(2122000000000000000 + i),
      created_timestamp: 1794800000 - i * 3600,
      replying_to: null,
      author: { screen_name: "test" },
      reposted_by: null,
    };
    if (kind === "short") return { ...base, text: "Yes." };
    if (kind === "url") return { ...base, text: "Read this https://example.com/a/very/long/path/that/keeps/going?utm_source=x&utm_medium=y&id=1234567890 and this https://t.co/abcdefghij" };
    if (kind === "emoji") return { ...base, text: "🔥🔥🔥 " + "🇺🇸".repeat(40) + " great news for everyone involved in this" };
    if (kind === "cjk") return { ...base, text: "这是一个关于政治经济政策的推文内容，用来测试分词器的字符与词元比例是否合理。".repeat(3) };
    if (kind === "long") return { ...base, text: "This is a long post about policy. ".repeat(14) };
    return { ...base, text: "Synthetic post about policy number " + i + " with filler to approximate a real tweet." };
  });
}

const model = "openai/gpt-oss-20b";
const budget = entryTokenBudget(model, PARTIAL_TOKENS);
console.log("model:", model);
console.log("input budget:", inputTokenBudget(model, PARTIAL_TOKENS), "| entry budget:", budget);
console.log("output:", OUTPUT_TOKENS, "| partial:", PARTIAL_TOKENS);
console.log("");

for (const n of [100, 500]) {
  for (const kind of ["plain", "short", "url", "emoji", "cjk", "long"]) {
    const posts = makePosts(n, kind);
    const chunks = chunkPosts(posts, budget);
    const prompts = chunks.map((c, i) =>
      buildPrompt("test", c, { index: i + 1, total: Math.max(2, chunks.length), totalPosts: posts.length, window: windowLabel(posts) })
    );
    const maxEst = Math.max(...prompts.map((p) => estimateTokens(p)));
    const maxChars = Math.max(...prompts.map((p) => p.length));
    const total = maxEst + PARTIAL_TOKENS;
    console.log(
      String(n).padStart(3) + " " + kind.padEnd(6),
      "chunks=" + String(chunks.length).padStart(2),
      "maxChars=" + String(maxChars).padStart(6),
      "estTokens=" + String(maxEst).padStart(5),
      "est+out=" + String(total).padStart(5),
      total <= 8000 ? "ok" : "OVER TPM"
    );
  }
}
