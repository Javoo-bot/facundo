// Pure half of collect.mjs and store-tone.mjs: facts kept outside the garden
// database (a Langfuse root observation, the tone check's file) in, rows for
// agent_trace_runs and agent_tone_scores out. No I/O, so monitoring.test.mjs
// drives it with plain objects.

import { createHash } from "node:crypto";
import { judgeTranslations, parseTranslationReply } from "../../dashboard/lib/messages/translate.ts";

// The runs whose measures live only in Langfuse (agents/thinking/*.md, Data lines).
export const TRACED_RUNS = ["babel.run", "bloom.run", "oracle.run", "polyglot.run"];

const OUTPUT_KEPT = 2000;

const text = (v) => (v == null ? null : typeof v === "string" ? v : JSON.stringify(v));

/** Reads the source text and target locales back out of the prompt that
 * buildTranslationPrompt (dashboard/lib/messages/translate.ts) wrote. Null when
 * the prompt is some other shape, so nothing is judged rather than misjudged. */
export function readTranslationPrompt(prompt) {
  const source = prompt?.match(/SOURCE \(English\):\n([\s\S]*?)\n\nTranslate it into each of these languages/);
  const block = prompt?.match(/keeping the same tone and roughly the same length:\n((?:- [^\n]+\n?)+)/);
  if (!source || !block) return null;
  const targets = [...block[1].matchAll(/^- ([A-Za-z-]+):/gm)].map((m) => m[1]);
  return targets.length ? { source: source[1], targets } : null;
}

/** Polyglot's reply judged again with the route's own check. A target the reply
 * left out, or a reply that cannot be read, fails for every missing locale. */
export function polyglotReplay(prompt, reply, key) {
  const asked = readTranslationPrompt(prompt);
  if (!asked || !key) return null;
  const verdicts = new Map(judgeTranslations(key, asked.source, parseTranslationReply(reply ?? "", asked.targets)).map((v) => [v.locale, v]));
  return asked.targets.map((locale) => {
    const v = verdicts.get(locale);
    return v ? { locale, ok: v.ok, reasons: v.reasons } : { locale, ok: false, reasons: ["no translation in the reply"] };
  });
}

export function traceRow(obs) {
  const input = text(obs.input);
  const output = text(obs.output);
  const metadata = obs.metadata && typeof obs.metadata === "object" ? obs.metadata : {};
  return {
    trace_id: obs.traceId,
    agent: metadata.agent_id ?? obs.name.split(".")[0],
    name: obs.name,
    started_at: obs.startTime,
    level: obs.level ?? null,
    session_id: obs.sessionId || null,
    input_md5: input == null ? null : createHash("md5").update(input).digest("hex"),
    output: output == null ? null : output.slice(0, OUTPUT_KEPT),
    metadata,
    replay: obs.name === "polyglot.run" ? polyglotReplay(input, output, metadata.key) : null,
  };
}

/** tone.json from agents/garden/tone/geval.py: a message the check could not
 * score is left out rather than stored as zero. */
export function toneRows(tone) {
  return (tone?.results ?? [])
    .filter((r) => r.id && typeof r.score === "number")
    .map((r) => ({ message_id: r.id, score: r.score, reason: r.reason ?? null, model: tone.model ?? null }));
}
