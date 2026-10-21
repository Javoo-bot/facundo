// May we record this call, and what must the caller be told first?
//
// Pure, alias-free, unit-tested. Recording a call is lawful in every market this
// targets WHEN both parties are notified — the entire risk sits in that
// condition, so this module is built so that "recording without a notice" is
// not a value it can return. `recordingDecision` either yields a notice or
// yields no recording; there is no third answer.
//
// Two separate things are decided here and they are deliberately not the same
// setting. A TRANSCRIPT is what makes an unattended agent auditable — without
// it nobody can ever answer "what did it actually say to them". AUDIO is more
// useful and more exposed, and its legal position varies by country. So audio
// can be switched off per market while transcripts continue everywhere.

export interface VoiceSettings {
  voice_record_audio?: boolean | null;
  voice_transcribe?: boolean | null;
  /** ISO alpha-2 -> boolean. Absent country falls back to voice_record_audio. */
  voice_record_by_country?: Record<string, unknown> | null;
  voice_retention_days?: number | string | null;
}

export interface RecordingDecision {
  /** Capture audio. Never true without `notice`. */
  recordAudio: boolean;
  /** Keep a text transcript. Never true without `notice`. */
  transcribe: boolean;
  /** What the caller must hear, in order, BEFORE either begins. Empty only
   * when nothing is being captured and nothing is required. */
  noticeParts: NoticePart[];
  /** When the captured data must be deleted, in days from now. */
  retentionDays: number;
}

/** The pieces of the opening. Kept as parts rather than one string so the
 * caller renders them from the catalog in the florist's language, and so a
 * test can assert WHICH obligations were covered rather than pattern-matching
 * prose. */
export type NoticePart = "ai" | "recording" | "transcript";

const DEFAULT_RETENTION_DAYS = 90;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;

function clampRetention(v: number | string | null | undefined): number {
  // null and "" MUST be handled before Number(), which turns both into 0 —
  // and 0 clamps to one day. An unset retention setting would then delete every
  // recording tomorrow rather than falling back to the default, which is the
  // opposite of what "unset" means and is silent when it happens.
  if (v === null || v === undefined || v === "") return DEFAULT_RETENTION_DAYS;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.floor(n)));
}

/** Country-level override for audio, falling back to the global switch.
 * Anything unparseable resolves to NOT recording — the safe direction, and the
 * one a regulator would expect a system to default to. */
export function mayRecordAudioIn(settings: VoiceSettings | null | undefined, country: string | null): boolean {
  const global = settings?.voice_record_audio === true;
  const map = settings?.voice_record_by_country;
  if (!country || !map || typeof map !== "object" || Array.isArray(map)) return global;
  const key = country.trim().toUpperCase();
  const entry = (map as Record<string, unknown>)[key];
  if (entry === undefined) return global;
  return entry === true;
}

/**
 * What may be captured on this call, and what must be said first.
 *
 * THE INVARIANT: `recordAudio` and `transcribe` are only ever true alongside a
 * notice that covers them. The caller (the ElevenLabs agent setup) plays
 * `noticeParts` before capture begins and records what it said on the
 * `voice_calls` row; if it cannot render the notice, it must not capture.
 *
 * The AI disclosure is ALWAYS in the notice, recording or not — that is the
 * standing policy for voice, and the EU AI Act obligation is independent of
 * whether anything is being stored.
 */
export function recordingDecision(
  settings: VoiceSettings | null | undefined,
  country: string | null
): RecordingDecision {
  const recordAudio = mayRecordAudioIn(settings, country);
  const transcribe = settings?.voice_transcribe !== false;

  const noticeParts: NoticePart[] = ["ai"];
  if (recordAudio) noticeParts.push("recording");
  else if (transcribe) noticeParts.push("transcript");

  return {
    recordAudio,
    transcribe,
    noticeParts,
    retentionDays: clampRetention(settings?.voice_retention_days),
  };
}

/** When captured data from a call starting now must be deleted. Stamped at call
 * time rather than computed at purge time, so shortening the policy later
 * cannot retroactively extend the life of data already collected. */
export function retainUntil(decision: RecordingDecision, nowMs: number): string {
  return new Date(nowMs + decision.retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

/** Is this call row due for purging? */
export function isPurgeDue(
  row: { retain_until?: string | null; purged_at?: string | null },
  nowMs: number
): boolean {
  if (row.purged_at) return false;
  if (!row.retain_until) return false;
  const due = Date.parse(row.retain_until);
  if (!Number.isFinite(due)) return false;
  return due <= nowMs;
}
