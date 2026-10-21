// Which voice a message goes out in — branded (the company shell) or plain
// (looks hand-written by a CX rep). Pure, alias-free, unit-tested.
//
// Two levels, most specific first:
//   1. the sequence STEP's own override (lib/sequences/definitions.ts) — this is
//      what makes a funnel work: a branded day-0 email followed by a plain
//      day-3 note from a named person.
//   2. the per-KIND default in app_settings.message_voice (Settings → Notifications).
//
// FAILS to "branded" on a missing row, a missing key, an unparseable value, or
// a null settings object — mirroring lib/emailToggles.ts's fail-open reasoning.
// Every email today is branded; a settings surprise must never silently change
// how the company's mail looks. The plain voice is always an explicit choice.

export type EmailVoice = "branded" | "plain";

export const EMAIL_VOICES: readonly EmailVoice[] = ["branded", "plain"];

export const DEFAULT_VOICE: EmailVoice = "branded";

export function isEmailVoice(x: unknown): x is EmailVoice {
  return x === "branded" || x === "plain";
}

export interface VoiceSettings {
  /** kind -> "branded" | "plain". Keys are the same `kind` strings
   * lib/communications.ts logs (offer, recruit.t1, cold_offer, persona_reply…). */
  message_voice?: Record<string, unknown> | null;
}

/** The configured default voice for a message kind. */
export function voiceForKind(settings: VoiceSettings | null | undefined, kind: string): EmailVoice {
  const map = settings?.message_voice;
  if (!map || typeof map !== "object" || Array.isArray(map)) return DEFAULT_VOICE;
  const value = (map as Record<string, unknown>)[kind];
  return isEmailVoice(value) ? value : DEFAULT_VOICE;
}

/** A sequence step's override wins over the per-kind default. Anything that
 * isn't a valid voice (null, undefined, a typo in a hand-edited row) is treated
 * as "no override" rather than as a reason to fall all the way back to
 * branded — the per-kind setting is still a deliberate choice and must hold. */
export function resolveVoice(stepVoice: unknown, kindVoice: EmailVoice): EmailVoice {
  return isEmailVoice(stepVoice) ? stepVoice : kindVoice;
}

/** One-shot resolution for a send site that has both. */
export function resolveVoiceFor(
  settings: VoiceSettings | null | undefined,
  kind: string,
  stepVoice?: unknown
): EmailVoice {
  return resolveVoice(stepVoice, voiceForKind(settings, kind));
}
