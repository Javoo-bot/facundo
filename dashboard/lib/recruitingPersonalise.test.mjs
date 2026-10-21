import test from "node:test";
import assert from "node:assert/strict";
import { personaliseRecruitingEmail, DEFAULT_RECRUITING_MODEL } from "./recruitingPersonalise.ts";

const PROMPT = "adapt this email";
const GOOD = "Subject: Commandes de fleurs a Lyon\n\nBonjour Marie,\n\n...";

function fakeFetch(response, capture = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    capture.body = init?.body ? JSON.parse(init.body) : null;
    return response;
  };
}
const ok = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

test("returns the personalised draft and calls OpenRouter's chat-completions endpoint", async () => {
  const cap = {};
  const out = await personaliseRecruitingEmail({ prompt: PROMPT, apiKey: "k", fetchImpl: fakeFetch(ok(GOOD), cap) });
  assert.equal(out, GOOD);
  assert.equal(cap.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(cap.init.headers.Authorization, "Bearer k");
  assert.equal(cap.body.model, DEFAULT_RECRUITING_MODEL);
  assert.equal(cap.body.messages[0].content, PROMPT);
});

test("the model is overridable, so a swap is config rather than a deploy", async () => {
  const cap = {};
  await personaliseRecruitingEmail({ prompt: PROMPT, apiKey: "k", model: "openai/gpt-5", fetchImpl: fakeFetch(ok(GOOD), cap) });
  assert.equal(cap.body.model, "openai/gpt-5");
});

// Every one of these must fall back to the deterministic catalog render rather
// than fail the outreach run or send something malformed.
test("returns null without an API key, and never calls out", async () => {
  let called = false;
  const out = await personaliseRecruitingEmail({
    prompt: PROMPT, apiKey: "",
    fetchImpl: async () => { called = true; return ok(GOOD); },
  });
  assert.equal(out, null);
  assert.equal(called, false);
});

test("returns null on a non-200", async () => {
  const out = await personaliseRecruitingEmail({ prompt: PROMPT, apiKey: "k", fetchImpl: fakeFetch({ ok: false, json: async () => ({}) }) });
  assert.equal(out, null);
});

test("returns null when the reply lost the Subject: contract", async () => {
  // The outreach panel parses the subject off the front; without it the send
  // would go out with no subject at all.
  const out = await personaliseRecruitingEmail({ prompt: PROMPT, apiKey: "k", fetchImpl: fakeFetch(ok("Bonjour Marie, ...")) });
  assert.equal(out, null);
});

test("returns null (never throws) when the call rejects or the body is malformed", async () => {
  const thrown = await personaliseRecruitingEmail({
    prompt: PROMPT, apiKey: "k",
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.equal(thrown, null);

  const badJson = await personaliseRecruitingEmail({
    prompt: PROMPT, apiKey: "k",
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("not json"); } }),
  });
  assert.equal(badJson, null);

  const noChoices = await personaliseRecruitingEmail({ prompt: PROMPT, apiKey: "k", fetchImpl: fakeFetch({ ok: true, json: async () => ({}) }) });
  assert.equal(noChoices, null);

  const emptyContent = await personaliseRecruitingEmail({ prompt: PROMPT, apiKey: "k", fetchImpl: fakeFetch(ok("   ")) });
  assert.equal(emptyContent, null);
});

test("handles the content-parts array form some models return", async () => {
  const parts = { ok: true, json: async () => ({ choices: [{ message: { content: [{ type: "text", text: GOOD }] } }] }) };
  assert.equal(await personaliseRecruitingEmail({ prompt: PROMPT, apiKey: "k", fetchImpl: fakeFetch(parts) }), GOOD);
});

test("a hung request is abandoned rather than stalling the batch", async () => {
  // The keep-alive timer is load-bearing, not scaffolding: AbortSignal.timeout()
  // creates an UNREF'd timer, so in a test process with nothing else pending the
  // event loop drains, the abort never fires, and this promise hangs forever —
  // which is exactly how this test cancelled itself (and the two after it) in
  // CI while passing locally. A ref'd timer holds the loop open so the real
  // timeout actually fires, the way a live fetch's socket does in production.
  const out = await personaliseRecruitingEmail({
    prompt: PROMPT, apiKey: "k", timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        assert.ok(init.signal instanceof AbortSignal, "no abort signal was passed to fetch");
        const keepAlive = setTimeout(() => reject(new Error("abort never fired")), 5000);
        init.signal.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(new Error("aborted"));
        });
      }),
  });
  assert.equal(out, null);
});

test("an aborted fetch rejection is swallowed into the fallback", async () => {
  const out = await personaliseRecruitingEmail({
    prompt: PROMPT, apiKey: "k",
    fetchImpl: async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    },
  });
  assert.equal(out, null);
});

// ---- no-em-dash backstop ----
// Not hypothetical: the first live OpenRouter call came back with five em
// dashes despite the prompt. Model prose is outbound copy and is held to the
// same rule as the catalog (see the guard in lib/i18n/i18n.test.mjs).
test("em dashes are stripped from the model's output", async () => {
  const dashed = "Subject: Orders in Lyon\n\nHi Marie — we were struck by your work — it stood out.";
  const out = await personaliseRecruitingEmail({ prompt: PROMPT, apiKey: "k", fetchImpl: fakeFetch(ok(dashed)) });
  assert.ok(!out.includes("—"), out);
  // A colon, not a comma: a comma there would be a splice.
  assert.match(out, /Hi Marie: we were struck/);
});

test("with LANGFUSE_* set, each call is traced under the calling agent, failures included", async () => {
  const keys = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "https://lf.example" });
  try {
    const traces = [];
    const world = (modelResponse) => async (url, init) => {
      if (url.startsWith("https://lf.example")) {
        const root = JSON.parse(init.body).resourceSpans[0].scopeSpans[0].spans[0];
        traces.push(Object.fromEntries(root.attributes.map((a) => [a.key, Object.values(a.value)[0]])));
        return { ok: true, status: 200, text: async () => "" };
      }
      return modelResponse;
    };
    const out = await personaliseRecruitingEmail({
      prompt: PROMPT, apiKey: "k", fetchImpl: world(ok(GOOD)), trace: { agent: "quill", sessionId: "florist-1" },
    });
    assert.equal(out, GOOD);
    await personaliseRecruitingEmail({
      prompt: PROMPT, apiKey: "k", requireSubjectLine: false, fetchImpl: world({ ok: false, json: async () => ({}) }),
      trace: { agent: "polyglot" },
    });

    assert.equal(traces.length, 2);
    assert.equal(traces[0]["langfuse.trace.name"], "Quill");
    assert.equal(traces[0]["langfuse.session.id"], "florist-1");
    assert.equal(traces[0]["langfuse.trace.input"], PROMPT);
    assert.equal(traces[0]["langfuse.trace.output"], GOOD);
    assert.equal(traces[1]["langfuse.trace.name"], "Polyglot");
    assert.equal(traces[1]["langfuse.observation.level"], "ERROR");
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("stripEmDashes leaves ordinary punctuation and hyphens alone", async () => {
  const { stripEmDashes } = await import("./recruitingPersonalise.ts");
  assert.equal(stripEmDashes("No 30- or 60-day terms."), "No 30- or 60-day terms.");
  assert.equal(stripEmDashes("hand-tied bouquets, 70% up front."), "hand-tied bouquets, 70% up front.");
  // An unspaced em dash degrades to a hyphen rather than eating a space.
  assert.equal(stripEmDashes("Lyon—Paris"), "Lyon-Paris");
});
