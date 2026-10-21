// Pure reply-subject builder, factored out of lib/agentTurn.ts so it can be
// unit-tested directly: this file imports nothing, so plain `node --test`
// needs no alias loader. Mirrors the split lib/offerEmailContent.ts uses for
// the same reason.
export function replySubject(subject: string | null | undefined): string | null {
  if (!subject) return null;
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}
