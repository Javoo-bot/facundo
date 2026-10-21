import test from "node:test";
import assert from "node:assert/strict";
import { resolvePersona, renderSignature, personaFromName, validatePersonaInput } from "./personas.ts";

const p = (over) => ({
  id: "p1",
  locale: "en",
  name: "Alex Doe",
  role_title: "Onboarding Manager",
  photo_url: null,
  reply_to: "alex@reply.example.com",
  phone_e164: null,
  signature_note: null,
  active: true,
  ...over,
});

test("resolves the persona for the requested locale", () => {
  const list = [p({ id: "en" }), p({ id: "es", locale: "es", name: "Marta Ruiz" })];
  assert.equal(resolvePersona("es", list)?.id, "es");
});

test("falls back to the EN persona when the market has none", () => {
  const list = [p({ id: "en" }), p({ id: "es", locale: "es" })];
  assert.equal(resolvePersona("de", list)?.id, "en");
});

test("falls back to any active persona when even EN is missing", () => {
  const list = [p({ id: "es", locale: "es" })];
  assert.equal(resolvePersona("de", list)?.id, "es");
});

test("inactive personas are never resolved", () => {
  const list = [p({ id: "es", locale: "es", active: false }), p({ id: "en" })];
  assert.equal(resolvePersona("es", list)?.id, "en");
});

test("no active persona at all resolves to null rather than inventing one", () => {
  assert.equal(resolvePersona("en", [p({ active: false })]), null);
  assert.equal(resolvePersona("en", []), null);
});

test("signature is name, role, brand — and omits an unset note entirely", () => {
  assert.equal(renderSignature(p()), "Alex Doe\nOnboarding Manager\nFacundo");
});

test("signature note renders after a blank line when set", () => {
  assert.equal(
    renderSignature(p({ signature_note: "I read every reply myself." })),
    "Alex Doe\nOnboarding Manager\nFacundo\n\nI read every reply myself."
  );
});

test("From name keeps the brand alongside the person", () => {
  assert.equal(personaFromName(p({ name: "Marta Ruiz" })), "Marta Ruiz (Facundo)");
});

// ---- input validation ----

const input = (over = {}) => ({
  locale: "es",
  name: "Marta Ruiz",
  role_title: "Onboarding Manager",
  reply_to: "Persona@reply.fc.example.net",
  ...over,
});

test("a well-formed persona validates and normalizes the reply address", () => {
  const r = validatePersonaInput(input());
  assert.ok(r.ok);
  assert.equal(r.value.reply_to, "persona@reply.fc.example.net");
  assert.equal(r.value.locale, "es");
  assert.equal(r.value.photo_url, null);
  assert.equal(r.value.signature_note, null);
});

test("an unsupported locale is rejected rather than silently defaulting", () => {
  // Defaulting here would hand a Dutch market the English persona under a
  // Dutch label — visible only once a prospect replies in the wrong language.
  const r = validatePersonaInput(input({ locale: "nl" }));
  assert.equal(r.ok, false);
  assert.match(r.message, /locale/);
});

// The signature invites a reply. An address that isn't an address turns every
// interested prospect into a bounce, which is the one failure the funnel
// cannot detect on its own.
test("a reply_to that isn't an address is rejected", () => {
  for (const bad of ["", "   ", "marta", "marta@", "@fc.example.net", "marta at fc.example.net"]) {
    const r = validatePersonaInput(input({ reply_to: bad }));
    assert.equal(r.ok, false, `accepted a bad reply_to: ${JSON.stringify(bad)}`);
    assert.match(r.message, /reply_to/);
  }
});

test("name and role are required and length-bounded", () => {
  assert.equal(validatePersonaInput(input({ name: "  " })).ok, false);
  assert.equal(validatePersonaInput(input({ role_title: "" })).ok, false);
  assert.equal(validatePersonaInput(input({ name: "x".repeat(81) })).ok, false);
  assert.equal(validatePersonaInput(input({ role_title: "x".repeat(81) })).ok, false);
});

test("blank optional fields become null, not empty strings", () => {
  // renderSignature branches on `signature_note` being falsy — an empty string
  // would slip past a null check and render a trailing blank line.
  const r = validatePersonaInput(input({ signature_note: "   ", photo_url: "", phone_e164: "" }));
  assert.ok(r.ok);
  assert.equal(r.value.signature_note, null);
  assert.equal(r.value.photo_url, null);
  assert.equal(r.value.phone_e164, null);
});

test("garbage input is rejected, never thrown on", () => {
  for (const junk of [null, undefined, "string", 42, [], { locale: 5 }]) {
    const r = validatePersonaInput(junk);
    assert.equal(r.ok, false, `accepted junk: ${JSON.stringify(junk)}`);
    assert.equal(typeof r.message, "string");
  }
});
