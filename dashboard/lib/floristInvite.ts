// Pure invite-validity decision logic. Kept separate from the API routes/layout so
// it's unit-testable without a DB — same split as lib/staffRoles.ts and
// lib/airwallex/revealGuard.ts.

export interface InviteRow {
  email: string;
  expires_at: string; // ISO timestamp
  accepted_at: string | null;
}

export type RedeemReason = "expired" | "accepted" | "email_mismatch";

export function canRedeemInvite(
  invite: InviteRow,
  signInEmail: string,
  now: Date
): { ok: true } | { ok: false; reason: RedeemReason } {
  if (invite.accepted_at) return { ok: false, reason: "accepted" };
  if (new Date(invite.expires_at).getTime() < now.getTime()) return { ok: false, reason: "expired" };
  if (invite.email.toLowerCase() !== signInEmail.toLowerCase()) return { ok: false, reason: "email_mismatch" };
  return { ok: true };
}
