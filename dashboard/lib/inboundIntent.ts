// What to do with an inbound message BEFORE any model sees it.
//
// Pure, alias-free, unit-tested. Two decisions live here, and both are
// deliberately made without an LLM:
//
//   1. Is this an opt-out? An LLM negotiating with someone who typed STOP is a
//      regulatory incident, not a missed conversion. The word list is short,
//      explicit, and the model never gets the chance.
//   2. Is this an auto-responder? An out-of-office bounced into an AI reply is
//      an infinite loop with a real business on the other end, and it must not
//      count as engagement either.

const OPT_OUT_WORDS = [
  // The carrier-standard SMS keywords first — these are the ones a florist is
  // most likely to type alone, and the ones with the least ambiguity.
  "stop", "stopp", "unsubscribe", "unsub", "quit", "cancel", "end",
  "arret", "arrêt", "arreter", "arrêter", "desabonner", "desinscription",
  "baja", "borrar", "cancelar", "eliminar", "darse de baja",
  "abmelden", "abbestellen", "loeschen", "löschen",
  "annulla", "cancella", "disiscrivi",
  "sair", "remover", "descadastrar",
];

const OPT_OUT_PHRASES = [
  "remove me", "take me off", "do not contact", "don't contact",
  "no me escribas", "no me contacten", "dejen de escribirme",
  "ne me contactez plus", "arretez de m'ecrire", "arrêtez de m'écrire",
  "non contattarmi", "non scrivetemi piu", "non scrivetemi più",
  "nicht mehr kontaktieren", "keine e-mails mehr", "keine mails mehr",
  "nao me contactem", "não me contactem", "parem de me escrever",
];

/** Strip accents so "arrêt" and "arret" are the same word. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

// The lists are folded ONCE, at load, and only folded values are ever compared.
// Without this, an accented entry ("löschen") could never match its own folded
// input ("loschen") — the German and French opt-outs would have silently failed
// while the unaccented spellings passed, which is exactly the kind of gap that
// only shows up as a complaint.
const OPT_OUT_WORD_SET = new Set(OPT_OUT_WORDS.map(fold));
const OPT_OUT_PHRASES_FOLDED = OPT_OUT_PHRASES.map(fold);

/**
 * Did this florist ask us to stop?
 *
 * A BARE keyword is an opt-out; the same word inside a sentence is not. That
 * distinction is the whole design: "stop" alone means stop, while "stop by the
 * shop next week" and "arrêtez-moi si je me trompe" are ordinary replies from
 * interested people, and treating either as an opt-out would silently lose
 * them. Multi-word PHRASES are matched anywhere, because "please remove me from
 * this list" has no bare-word form.
 */
export function isOptOut(body: string | null | undefined): boolean {
  if (!body) return false;
  const folded = fold(body);
  if (folded.length === 0) return false;

  // Bare keyword: the entire message is one of the words (possibly with
  // punctuation or a signature-free line break around it).
  const stripped = folded.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (OPT_OUT_WORD_SET.has(stripped)) return true;
  // "stop please" / "please stop" — still unambiguous at two words.
  const words = stripped.split(" ");
  if (words.length <= 2 && words.some((w) => OPT_OUT_WORD_SET.has(w))) return true;

  return OPT_OUT_PHRASES_FOLDED.some((p) => folded.includes(p));
}

export interface InboundHeaders {
  [key: string]: string | undefined;
}

const AUTO_SUBJECT_PREFIXES = [
  "out of office", "automatic reply", "auto reply", "autoreply",
  "abwesenheit", "automatische antwort",
  "absence du bureau", "reponse automatique", "réponse automatique",
  "fuori sede", "risposta automatica",
  "ausencia", "respuesta automatica", "respuesta automática",
  "ausente do escritorio", "resposta automatica", "resposta automática",
];

/**
 * Is this a machine talking?
 *
 * Headers first — they are unambiguous and standardised. The subject prefixes
 * are a fallback for senders that set none, which is common enough that
 * skipping them would leave the loop open.
 */
export function isAutoReply(headers: InboundHeaders | null | undefined, subject?: string | null): boolean {
  const h = headers ?? {};
  const get = (k: string) => {
    const found = Object.keys(h).find((key) => key.toLowerCase() === k);
    return found ? (h[found] ?? "").toLowerCase() : "";
  };

  const autoSubmitted = get("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (get("x-autoreply") || get("x-autorespond") || get("x-auto-response-suppress")) return true;
  const precedence = get("precedence");
  if (["bulk", "auto_reply", "junk", "list"].includes(precedence)) return true;
  if (get("list-id") || get("list-unsubscribe")) return true;

  const s = fold(subject ?? "");
  return AUTO_SUBJECT_PREFIXES.some((p) => s.startsWith(fold(p)) || s.includes(`re: ${fold(p)}`));
}

export type InboundDisposition = "opt_out" | "auto_reply" | "answer";

/** The one triage call both webhooks make. `answer` is the only outcome that
 * reaches the model. */
export function classifyInbound(
  body: string | null | undefined,
  headers?: InboundHeaders | null,
  subject?: string | null
): InboundDisposition {
  // Opt-out is checked FIRST. An auto-responder that happens to contain an
  // unsubscribe request is still an unsubscribe request, and honouring it
  // costs us nothing.
  if (isOptOut(body)) return "opt_out";
  if (isAutoReply(headers, subject)) return "auto_reply";
  return "answer";
}
