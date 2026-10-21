// The weather's catalogue: the invented world the garden orders land in, and
// one scenario per /lifecycle branch it can grow. Branch ids come from
// dashboard/lib/lifecycle.ts; a scenario with branch null is a happy path.
//
// The world sits in an empty stretch of Extremadura around 39.75,-5.95: the
// nearest real florist in the garden DB is 197 km away (checked 2026-10-13)
// and towns are 50+ km apart, beyond the 20 km match cap, so each town's
// orders only ever meet that town's florists.

export const MARK = "GARDEN";

export const TOWNS = {
  RA: { city: "Valderrosas", lat: 39.5, lng: -6.3, zip: "10600", province: "Cáceres" },
  RB: { city: "Monteflor", lat: 39.5, lng: -5.7, zip: "10610", province: "Cáceres" },
  RC: { city: "Yermo de la Sierra", lat: 40.0, lng: -6.3, zip: "10620", province: "Cáceres" },
  RD: { city: "Sincorreo de Arriba", lat: 40.0, lng: -5.7, zip: "10630", province: "Cáceres" },
  RE: { city: "Lejanía del Monte", lat: 40.5, lng: -6.3, zip: "10640", province: "Cáceres" },
  RF: { city: "Prospera", lat: 40.5, lng: -5.7, zip: "10650", province: "Cáceres" },
  RG: { city: "Llenaflor", lat: 39.0, lng: -6.3, zip: "10660", province: "Badajoz" },
  RH: { city: "Bajalista", lat: 39.0, lng: -5.7, zip: "10670", province: "Badajoz" },
};

// n/e: km north/east of the town centre. Every email is a plus-address of
// app_settings.test_email, and nobody has a phone, so no SMS can leave.
const shop = (key, town, name, n, e, extra = {}) => ({
  key, town, name, n, e, email: true, stage: "production", tier: "2", capacity: 50, radius: 20, optOut: false, ...extra,
});
export const SHOPS = [
  shop("A1", "RA", "Floristería La Rosa", 0, 0.8),
  shop("A2", "RA", "Flores del Lirio", 2.5, 0),
  shop("A3", "RA", "Jardín Dalia", -6, 0),
  shop("B1", "RB", "Floristería Monteflor", 0, 1),
  shop("D1", "RD", "Flores Sin Correo", 1, 0, { email: false }),
  shop("D2", "RD", "Ramos Sin Correo", -2, 0, { email: false }),
  shop("E1", "RE", "Floristería del Puerto", 15, 0, { radius: 25 }),
  shop("F1", "RF", "Flores Prospera", 0, 1, { stage: "found", tier: null }),
  shop("G1", "RG", "Floristería Llena", 0, 1, { capacity: 0 }),
  shop("H1", "RH", "Flores de Baja", 0, 1, { optOut: true }),
];

// `budget(w)` is how long the loop may take, in minutes, given `w`, the offer
// window it will use for this order (app_settings.offer_window_*_min, picked by
// delivery lead time). The score reads it as expected.max_minutes.
//
// `actor` steps are a PLACEHOLDER puppet (weather-puppet.mjs) that clicks the
// florist app's own HTTP routes until the tester.army personas and the Ollama
// reply actors replace it. `after` is minutes after the step's trigger: the
// live offer's sent_at (accept, decline, cancel), the accept (photo), or the
// offer lapsing with the order escalated (late_accept).
const happy = (key, title, order = {}) => ({
  key, stage: "delivered", branch: null, title, happy: true, town: "RA", order,
  outcome: "paid", budget: (w) => w + 30,
  actor: [{ do: "accept", after: 3 }, { do: "photo", photo: "bouquet", after: 8 }],
});

export const SCENARIOS = [
  happy("happy", "Happy path: florist accepts and sends the photo"),
  happy("happy-far-date", "Happy path, delivery four days out", { daysOut: 4 }),
  happy("happy-city-misspelled", "Happy path, city spelled differently (coordinates present)", { city: "Valderosas" }),
  happy("happy-afternoon", "Happy path, afternoon delivery window", { window: "16:00-20:00" }),
  {
    key: "webhook-hmac", stage: "webhook", branch: "webhook-hmac", title: "Webhook arrives with a bad signature",
    town: "RA", deliver: "bad-signature", outcome: "rejected", budget: () => 5,
    expect: { order_row: false, webhook_status: 401 },
  },
  {
    key: "webhook-replay", stage: "webhook", branch: "webhook-replay", title: "Shopify delivers the same order webhook twice",
    town: "RA", deliver: "replay", outcome: "paid", budget: (w) => w + 30,
    expect: { order_rows: 1 },
    actor: [{ do: "accept", after: 3 }, { do: "photo", photo: "bouquet", after: 8 }],
  },
  {
    key: "parse-malformed", stage: "intake-parse", branch: "parse-malformed", title: "Order with no delivery date and an empty street",
    town: "RA", order: { noDate: true, address1: "" }, outcome: "escalated", budget: () => 30,
    expect: { no_offer_sent: true, lifecycle_status: "open" },
  },
  {
    key: "outside-working-set", stage: "match", branch: "match-order-outside-working-set", title: "Order without the GARDEN tag stays parked",
    town: "RA", order: { tags: "GARDEN-PARKED" }, outcome: "received", budget: () => 30,
    expect: { no_candidates: true },
  },
  {
    key: "match-none", stage: "match", branch: "match-none", title: "No florist within reach",
    town: "RC", outcome: "escalated", budget: () => 10,
  },
  {
    key: "match-no-coordinates", stage: "match", branch: "match-no-coordinates", title: "Order arrives without coordinates",
    town: "RA", order: { coords: false }, outcome: "escalated", budget: () => 10,
  },
  {
    key: "match-capacity", stage: "match", branch: "match-capacity", title: "The only florist is full for the day",
    town: "RG", outcome: "escalated", budget: () => 10,
  },
  {
    key: "match-thin", stage: "match", branch: "match-thin", title: "Only one florist, 15 km out, and it never answers",
    town: "RE", outcome: "escalated", budget: (w) => w + 15, expect: { offers_sent: 1 },
  },
  {
    key: "reachout-timeout", stage: "reachout-send", branch: "reachout-timeout", title: "The only florist lets the offer lapse",
    town: "RB", outcome: "escalated", budget: (w) => w + 15, expect: { escalation_reason: "no_answer" },
  },
  {
    key: "reachout-exhausted", stage: "reachout-send", branch: "reachout-exhausted", title: "Three florists, none answers",
    town: "RA", outcome: "escalated", budget: (w) => 3 * w + 20, expect: { offers_sent: 3 },
  },
  {
    key: "reachout-decline", stage: "reachout-send", branch: "reachout-decline", title: "First florist says no, the next one is offered",
    town: "RA", outcome: "reoffered", budget: () => 10, expect: { declines: 1, offers_sent_min: 2 },
    actor: [{ do: "decline", after: 3 }],
  },
  {
    key: "reachout-late-accept", stage: "reachout-send", branch: "reachout-late-accept", title: "Florist accepts after the offer lapsed and the order went to CX",
    town: "RB", outcome: "accepted", budget: (w) => w + 30, expect: { late_accept_event: true },
    actor: [{ do: "late_accept", after: 2 }],
  },
  {
    key: "reachout-unreachable", stage: "reachout-send", branch: "reachout-candidate-unreachable", title: "Florists in range have no email and no phone",
    town: "RD", outcome: "escalated", budget: () => 10, expect: { escalation_reason: "no_contact" },
  },
  {
    key: "reachout-unsubscribed", stage: "reachout-send", branch: "reachout-florist-unsubscribed", title: "The only florist unsubscribed from offer emails",
    town: "RH", outcome: "escalated", budget: () => 10,
  },
  {
    key: "reachout-cold-offer", stage: "reachout-send", branch: "reachout-cold-offer", title: "Only a shop outside the network is near: it gets a cold offer",
    town: "RF", outcome: "escalated", budget: (w) => w + 15, expect: { cold_offer_sent: true },
  },
  {
    key: "accept-then-bail", stage: "florist-accept", branch: "accept-then-bail", title: "Florist accepts and then goes quiet, no photo",
    town: "RA", outcome: "accepted", budget: null, expect: { chase_photo_filed: true },
    actor: [{ do: "accept", after: 3 }],
  },
  {
    key: "deliver-bad-photo", stage: "deliver-photo", branch: "deliver-bad-photo", title: "Florist uploads a screenshot instead of the bouquet",
    town: "RA", outcome: "held", budget: (w) => w + 30, expect: { photo_verdict: ["review", "fail"], lifecycle_status: "open" },
    actor: [{ do: "accept", after: 3 }, { do: "photo", photo: "screenshot", after: 8 }],
  },
  {
    key: "order-cancelled", stage: "cross-cutting", branch: "x-order-cancelled", title: "Customer cancels while the offer is out",
    town: "RA", outcome: "cancelled", budget: () => 20,
    actor: [{ do: "cancel", after: 5 }],
  },
];

export const PER_DAY = 20;

/** The day's mix: every happy path, then a seeded draw of the failure branches. */
export function pickForDay(rand) {
  const happyOnes = SCENARIOS.filter((s) => s.happy);
  const rest = SCENARIOS.filter((s) => !s.happy)
    .map((s) => [rand(), s]).sort((a, b) => a[0] - b[0]).map(([, s]) => s)
    .slice(0, PER_DAY - happyOnes.length);
  return [...happyOnes, ...rest].map((s) => [rand(), s]).sort((a, b) => a[0] - b[0]).map(([, s]) => s);
}

export const RECIPIENTS = [
  "María García López", "Lucía Fernández Ruiz", "Carmen Sánchez Díaz", "Ana Martín Gómez", "Isabel Romero Torres",
  "Pilar Navarro Gil", "Elena Ortega Vega", "Rosa Molina Castro", "Teresa Delgado Ramos", "Marta Iglesias Cano",
];
export const CARDS = [
  "¡Feliz cumpleaños, mamá! Con todo nuestro cariño.",
  "Enhorabuena por el nuevo trabajo. Un abrazo enorme.",
  "Te echamos de menos. Mejórate pronto.",
  "Feliz aniversario, cariño. Por muchos años más.",
  "Gracias por todo. Eres la mejor.",
];
