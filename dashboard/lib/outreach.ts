const FALLBACK_SUBJECT = "Partnering with Facundo";

/** Split a stored drafted_email ("Subject: X\n\n<body>") into an editable
 * subject + body. Falls back to a default subject when there's no Subject line. */
export function parseDraft(draft: string | null): { subject: string; body: string } {
  if (!draft) return { subject: FALLBACK_SUBJECT, body: "" };
  const m = draft.match(/^\s*Subject:\s*(.+?)\r?\n(?:\r?\n)?([\s\S]*)$/);
  if (m) return { subject: m[1].trim(), body: m[2].trim() };
  return { subject: FALLBACK_SUBJECT, body: draft.trim() };
}
