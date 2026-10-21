/** The one place the outbound From address is decided.
 *
 * Ongage and Resend are bound to different verified sending domains — Ongage's
 * connection sends as noreply@fc.example.com, Resend's verified domain is
 * fc.example.net — so an address valid on one is rejected or spam-foldered on
 * the other. The From address is therefore not something each send site
 * should pick for itself: it's resolved here against whichever transport
 * EMAIL_TRANSPORT currently selects (lib/emailTransport.ts), so a send site
 * never has to know or guess which provider is live in this environment.
 * `ONGAGE_FROM` / `RESEND_FROM` each override that transport's default; both
 * must stay on their own transport's verified domain.
 *
 * Relative import (with its .ts extension) rather than the usual `@/lib/...`
 * alias: this file is imported relatively by lib/ongage.test.mjs and run
 * under plain `node --test`, which has no alias resolution. */
import { resolveEmailTransport } from "./emailTransport.ts";

export const DEFAULT_FROM = "Facundo <noreply@fc.example.com>"; // Ongage default
export const DEFAULT_RESEND_FROM = "Facundo <noreply@fc.example.net>";

/** Display-name form, e.g. `Facundo <noreply@fc.example.com>`. Falls back
 * to the Ongage-shaped default whenever EMAIL_TRANSPORT doesn't resolve to
 * "resend" — including when it's unset or itself misconfigured, in which
 * case sendEmail() fails closed anyway and this value is never sent. */
export function defaultFrom(): string {
  return resolveEmailTransport() === "resend"
    ? process.env.RESEND_FROM || DEFAULT_RESEND_FROM
    : process.env.ONGAGE_FROM || DEFAULT_FROM;
}

/** Bare address of `defaultFrom()`, for send sites that put their own display
 * name in front (outreach personas sign as "Marta Ruiz <noreply@…>"). */
export function defaultFromAddress(): string {
  return parseFrom(defaultFrom()).address;
}

/** `"Name <addr>"` → `{ name, address }`; a bare address gets `name: ""`. */
export function parseFrom(from: string): { name: string; address: string } {
  const m = from.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { name: (m[1] ?? "").trim(), address: m[2].trim() };
  return { name: "", address: from.trim() };
}
