// The named outreach persona — pure resolution + signature rendering.
//
// Alias-free (relative imports only) so plain `node --test` can reach it, same
// constraint as lib/recruitingContent.ts, lib/offerEmailContent.ts and
// lib/offerSmsContent.ts. No I/O: the caller loads the rows (one query, cached
// for the whole tick) and hands them in.
//
// WHY a resolver rather than a lookup: a market can be live before it has a
// persona (we ingest a city the week before anyone is assigned to it), and a
// follow-up email signed by nobody is worse than one signed by the EN persona.
// So resolution always terminates in something renderable, and the caller never
// has to branch on null.

import { DEFAULT_LOCALE, LOCALES, type Locale } from "./i18n/locales.ts";

export interface Persona {
  id: string;
  locale: string;
  name: string;
  role_title: string;
  photo_url: string | null;
  reply_to: string;
  phone_e164: string | null;
  signature_note: string | null;
  active: boolean;
}

/** The active persona for `locale`, falling back to the EN persona and then to
 * the first active row. Returns null ONLY when there are no active personas at
 * all — a genuine "nobody has been configured yet" state that callers surface
 * as a skip reason rather than papering over with an invented name. */
export function resolvePersona(locale: Locale, personas: Persona[]): Persona | null {
  const active = personas.filter((p) => p.active);
  if (active.length === 0) return null;
  return (
    active.find((p) => p.locale === locale) ??
    active.find((p) => p.locale === DEFAULT_LOCALE) ??
    active[0]
  );
}

/** The plain-text sign-off block. Deliberately plain text (not HTML): it is
 * appended to the body BEFORE the shell renders, so the same three lines feed
 * both the branded and the plain email voice and the plain-text fallback that
 * lib/email.ts requires alongside every HTML send.
 *
 * `signature_note` is the one free line a persona can carry ("I read every
 * reply myself") — omitted entirely when unset rather than rendering a blank
 * line, which in the plain voice would look like a broken template. */
export function renderSignature(persona: Persona): string {
  const lines = [persona.name, persona.role_title, "Facundo"];
  if (persona.signature_note) lines.push("", persona.signature_note);
  return lines.join("\n");
}

// ---- Input validation (pure; the route does the I/O) ----

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface PersonaInput {
  locale: string;
  name: string;
  role_title: string;
  reply_to: string;
  photo_url: string | null;
  signature_note: string | null;
  phone_e164: string | null;
}

export type ValidationResult =
  | { ok: true; value: PersonaInput }
  | { ok: false; message: string };

/** Validates a persona submitted from the Settings panel.
 *
 * `reply_to` is checked hardest because it is the one field that can make the
 * persona dishonest: the funnel's follow-ups invite a reply, so an address
 * that doesn't exist turns every interested prospect into a bounce. We can't
 * verify deliverability here, but we can refuse something that isn't an
 * address at all. */
export function validatePersonaInput(raw: unknown): ValidationResult {
  const b = (raw ?? {}) as Record<string, unknown>;

  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
  const optional = (k: string) => {
    const v = str(k);
    return v.length > 0 ? v : null;
  };

  const locale = str("locale");
  if (!(LOCALES as string[]).includes(locale)) {
    return { ok: false, message: `locale must be one of: ${LOCALES.join(", ")}.` };
  }

  const name = str("name");
  if (name.length === 0) return { ok: false, message: "name is required." };
  if (name.length > 80) return { ok: false, message: "name must be 80 characters or fewer." };

  const roleTitle = str("role_title");
  if (roleTitle.length === 0) return { ok: false, message: "role_title is required." };
  if (roleTitle.length > 80) return { ok: false, message: "role_title must be 80 characters or fewer." };

  const replyTo = str("reply_to").toLowerCase();
  if (!EMAIL_RE.test(replyTo)) {
    return { ok: false, message: "reply_to must be a valid email address a human actually reads." };
  }

  const note = optional("signature_note");
  if (note && note.length > 200) return { ok: false, message: "signature_note must be 200 characters or fewer." };

  return {
    ok: true,
    value: {
      locale,
      name,
      role_title: roleTitle,
      reply_to: replyTo,
      photo_url: optional("photo_url"),
      signature_note: note,
      phone_e164: optional("phone_e164"),
    },
  };
}

/** The From display name for a persona-sent message: "Marta Ruiz (Facundo)".
 *
 * The brand stays in the From line even on the plain voice. Dropping it would
 * read as a stranger's cold email to a shop that has heard of Facundo and
 * not of Marta — and to a spam filter, as an unrecognised sender on a domain
 * whose reputation is entirely Facundo's. The plain voice is about the
 * message looking hand-written, not about hiding who sent it. */
export function personaFromName(persona: Persona): string {
  return `${persona.name} (Facundo)`;
}
