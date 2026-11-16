/* Exercises worker/src/index.js in Node: CORS, rate limiting, batching, Groq errors.
 * Run: node worker/test/harness.mjs
 */

import worker from "../src/index.js";

const calls = [];
let groqMode = "ok";

globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  calls.push({ model: body.model, max: body.max_completion_tokens, effort: body.reasoning_effort, json: !!body.response_format, chars: body.messages[1].content.length });

  if (groqMode === "empty" && body.max_completion_tokens <= 1400) {
    return new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { completion_tokens_details: { reasoning_tokens: body.max_completion_tokens } } }), { status: 200 });
  }
  if (groqMode === "badjson") {
    return new Response(JSON.stringify({ error: { message: "Failed to validate JSON. Please adjust your prompt.", failed_generation: '{"economic": 0.1,' } }), { status: 400 });
  }
  const payload = {
    economic: -0.55, social: -0.15, confidence: 0.68,
    summary: "Merged reading.", themes: ["labour"],
    evidence: [], caveats: "none",
  };
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }] }), { status: 200 });
};

const store = new Map();
const env = {
  GROQ_API_KEY: "test-key",
  ALLOWED_ORIGINS: "https://example.github.io",
  RATE: {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
  },
};

const posts = Array.from({ length: 200 }, (_, i) => ({
  id: String(2122000000000000000 + i),
  text: "Synthetic post about policy number " + i + " with filler to approximate a real tweet.",
  created_timestamp: 1794800000 - i * 3600,
  replying_to: null,
  author: { screen_name: "test" },
  reposted_by: null,
}));

function req(body, { ip = "1.2.3.4", method = "POST", origin = "https://example.github.io", path = "/analyse" } = {}) {
  return new Request("https://proxy.example" + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": ip },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log((pass ? "ok   " : "FAIL ") + name + (detail ? "  " + detail : ""));
};

// 1. preflight
let res = await worker.fetch(req(null, { method: "OPTIONS" }), env);
check("OPTIONS 204", res.status === 204, "status=" + res.status);
check("CORS echoes allowed origin", res.headers.get("Access-Control-Allow-Origin") === "https://example.github.io", res.headers.get("Access-Control-Allow-Origin"));

// 2. disallowed origin is rejected before any work
calls.length = 0;
res = await worker.fetch(req({ handle: "x", posts }, { origin: "https://evil.example" }), env);
check("CORS blocks unknown origin", res.status === 403, "status=" + res.status);
check("blocked origin does no Groq work", calls.length === 0, "calls=" + calls.length);
check("blocked origin burns no quota", store.size === 0, "keys=" + [...store.keys()].join(","));

// 3. happy path, 200 posts -> 2 batches + synthesis
store.clear();
calls.length = 0;
res = await worker.fetch(req({ handle: "AOC", model: "openai/gpt-oss-20b", posts }), env);
let body = await res.json();
check("200 posts -> 200", res.status === 200, "status=" + res.status);
check("batches = 2", body.batches === 2, "batches=" + body.batches);
check("3 Groq calls (2 partial + synth)", calls.length === 3, "calls=" + calls.length);
check("reasoning_effort low", calls.every((c) => c.effort === "low"), JSON.stringify(calls.map((c) => c.effort)));
check("max_completion_tokens set", calls.every((c) => typeof c.max === "number"), JSON.stringify(calls.map((c) => c.max)));
check("result has scores", body.result.economic === -0.55 && body.result.social === -0.15, JSON.stringify({ e: body.result.economic, s: body.result.social }));

// 4. rate limited on second request from same IP
res = await worker.fetch(req({ handle: "AOC", model: "openai/gpt-oss-20b", posts }), env);
body = await res.json();
check("second request 429", res.status === 429, "status=" + res.status);
check("retry_after ~600", body.retry_after > 590 && body.retry_after <= 600, "retry_after=" + body.retry_after);
check("Retry-After header", res.headers.get("Retry-After") === String(body.retry_after), res.headers.get("Retry-After"));

// 5. different IP is unaffected
res = await worker.fetch(req({ handle: "AOC", model: "openai/gpt-oss-20b", posts }, { ip: "9.9.9.9" }), env);
check("other IP allowed", res.status === 200, "status=" + res.status);

// 6. failure does not burn the quota
store.clear();
groqMode = "badjson";
res = await worker.fetch(req({ handle: "AOC", posts }, { ip: "5.5.5.5" }), env);
check("groq failure -> 502", res.status === 502, "status=" + res.status);
check("quota not consumed on failure", !store.has("rl:5.5.5.5"), "keys=" + [...store.keys()].join(","));

// 7. empty completion doubles the budget
store.clear();
groqMode = "empty";
calls.length = 0;
res = await worker.fetch(req({ handle: "AOC", posts }, { ip: "6.6.6.6" }), env);
check("empty completion recovers", res.status === 200, "status=" + res.status);
check("budget doubled", calls.some((c) => c.max === 2800), JSON.stringify(calls.map((c) => c.max)));

// 8. validation
groqMode = "ok";
res = await worker.fetch(req({ handle: "", posts }, { ip: "7.7.7.7" }), env);
check("missing handle 400", res.status === 400, "status=" + res.status);
res = await worker.fetch(req({ handle: "AOC", posts: [] }, { ip: "8.8.8.8" }), env);
check("missing posts 400", res.status === 400, "status=" + res.status);
res = await worker.fetch(req({}, { ip: "8.8.8.8", path: "/nope" }), env);
check("unknown path 404", res.status === 404, "status=" + res.status);

const failed = results.filter((r) => !r.pass);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exit(failed.length ? 1 : 0);
