/** Fields on `florists` this route is allowed to touch — contact/basic info only.
 * Kept separate from operational fields (trust_tier, delivery_radius_km, ...),
 * which have their own route (app/api/florists/operational/route.ts). */
export const EDITABLE_DETAIL_FIELDS = [
  "name",
  "address",
  "email",
  "phone_web",
  "phone_maps",
  "owner_name",
  "website_url",
] as const;

export type DetailField = (typeof EDITABLE_DETAIL_FIELDS)[number];
export type DetailValues = Partial<Record<DetailField, string | null>>;

// Mirrors the permissive pattern used across the dashboard (e.g. lib/offerVars.ts) —
// unicode-tolerant in the local part so accented addresses like
// "concepciónperez@correo-demo.es" are accepted, not just ASCII ones.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateDetailsUpdate(
  body: Record<string, unknown>
): { ok: true; update: DetailValues } | { ok: false; error: string } {
  const update: DetailValues = {};

  for (const field of EDITABLE_DETAIL_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field];

    if (field === "name") {
      if (typeof raw !== "string" || !raw.trim()) {
        return { ok: false, error: "name must be a non-empty string." };
      }
      update.name = raw.trim();
      continue;
    }

    if (raw !== null && typeof raw !== "string") {
      return { ok: false, error: `${field} must be a string or null.` };
    }
    const trimmed = raw === null ? null : raw.trim() || null;

    if (field === "email" && trimmed !== null && !EMAIL_RE.test(trimmed)) {
      return { ok: false, error: "email must be a valid email address or null." };
    }

    update[field] = trimmed;
  }

  return { ok: true, update };
}

/** Builds one combined florist_notes body describing every field that actually
 * changed, or null if the update is a no-op. Only compares fields present in
 * `update` — fields the caller didn't touch are irrelevant to the diff. */
export function buildDetailsChangeNote(before: DetailValues, update: DetailValues): string | null {
  const changes: string[] = [];
  for (const field of Object.keys(update) as DetailField[]) {
    const oldValue = before[field] ?? null;
    const newValue = update[field] ?? null;
    if (oldValue === newValue) continue;
    changes.push(`${field}: "${oldValue ?? "(empty)"}" → "${newValue ?? "(empty)"}"`);
  }
  if (!changes.length) return null;
  return `Updated details — ${changes.join("; ")}.`;
}
