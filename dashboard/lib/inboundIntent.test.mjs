import test from "node:test";
import assert from "node:assert/strict";
import { isOptOut, isAutoReply, classifyInbound } from "./inboundIntent.ts";

test("a bare opt-out keyword is honoured, in every market", () => {
  for (const t of [
    "STOP", "stop", "Stop.", "unsubscribe", "QUIT",
    "ARRET", "arrêt", "arrêter",
    "BAJA", "cancelar",
    "abmelden", "ABBESTELLEN", "löschen",
    "annulla", "disiscrivi",
    "sair", "descadastrar",
    "stop please", "please stop",
  ]) {
    assert.ok(isOptOut(t), `missed an opt-out: ${t}`);
  }
});

test("multi-word opt-out phrases are matched anywhere in the message", () => {
  for (const t of [
    "Hi, please remove me from this list, thanks.",
    "Take me off your mailing list.",
    "Do not contact me again.",
    "Por favor, no me escribas mas.",
    "Merci de ne me contactez plus.",
    "Bitte keine E-Mails mehr an diese Adresse.",
    "Por favor, parem de me escrever.",
  ]) {
    assert.ok(isOptOut(t), `missed an opt-out: ${t}`);
  }
});

// The distinction the whole design turns on. Treating these as opt-outs would
// silently lose interested florists, and they'd never know why we went quiet.
test("an opt-out word inside an ordinary sentence is NOT an opt-out", () => {
  for (const t of [
    "Sure, stop by the shop next week and we can talk.",
    "Arrêtez-moi si je me trompe, mais c'est bien 70% ?",
    "I had to cancel one order last month, is that a problem?",
    "We're closed for holidays, so I'd end up declining those.",
    "Can you cancel the last one and send a new one?",
    "Baja California is too far for us to deliver.",
  ]) {
    assert.ok(!isOptOut(t), `false opt-out: ${t}`);
  }
});

test("empty and missing bodies are not opt-outs", () => {
  for (const t of ["", "   ", null, undefined]) assert.ok(!isOptOut(t), String(t));
});

// ---- auto-responders ----

test("standard auto-reply headers are detected", () => {
  assert.ok(isAutoReply({ "Auto-Submitted": "auto-replied" }));
  assert.ok(isAutoReply({ "auto-submitted": "auto-generated" }));
  assert.ok(isAutoReply({ "X-Autoreply": "yes" }));
  assert.ok(isAutoReply({ Precedence: "bulk" }));
  assert.ok(isAutoReply({ "List-Id": "<news.example.com>" }));
});

test("Auto-Submitted: no is a real human reply", () => {
  assert.ok(!isAutoReply({ "Auto-Submitted": "no" }));
});

test("localized out-of-office subjects are detected when headers are missing", () => {
  for (const s of [
    "Out of Office: your email",
    "Automatic reply: Would you take flower orders?",
    "Abwesenheit: Ich bin nicht im Buero",
    "Réponse automatique : absence",
    "Risposta automatica",
    "Respuesta automática: vacaciones",
    "Re: Automatic reply",
  ]) {
    assert.ok(isAutoReply({}, s), `missed an auto-reply subject: ${s}`);
  }
});

test("an ordinary reply subject is not an auto-reply", () => {
  assert.ok(!isAutoReply({}, "Re: Would you take flower orders in Girona?"));
  assert.ok(!isAutoReply(null, null));
});

// ---- triage ----

test("only a genuine human reply reaches the model", () => {
  assert.equal(classifyInbound("STOP"), "opt_out");
  assert.equal(classifyInbound("I'm away", { "Auto-Submitted": "auto-replied" }), "auto_reply");
  assert.equal(classifyInbound("Yes, interested — how fast are the orders?"), "answer");
});

// An out-of-office that contains an unsubscribe request is still one, and
// honouring it costs nothing.
test("an opt-out inside an auto-reply is still honoured", () => {
  assert.equal(
    classifyInbound("Please remove me from this list.", { "Auto-Submitted": "auto-replied" }),
    "opt_out"
  );
});
