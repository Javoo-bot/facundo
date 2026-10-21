// The three funnels, as one screen of data.
//
// A "funnel" here is what the team calls a funnel: everything we send between
// an order (or a scraped shop) existing and someone saying yes. That is not
// the same object as a `SequenceDef` — two of the three funnels ARE sequences,
// and the third (assigning an order to a florist in the network) is the offer
// wave, which has no enrolment at all. This file is the only place those two
// shapes are joined, so /flows can show one consistent thing without the wave
// engine growing a fake sequence or the sequence engine growing a fake wave.
//
// Pure, alias-free, no I/O — the same constraint lib/sequences/definitions.ts
// and lib/messages/registry.ts hold, so it is unit-testable and the editor,
// the API and the tests all agree on what exists.
//
// The SHAPE is code; the words and the waits are not:
//   * subject + body  → the message catalog + message_overrides (/messages)
//   * wait time       → sequence_step_timing (this page writes it)
//   * response window → app_settings.offer_window_*_min (this page writes it)
//   * cut-off offset  → app_settings.cx_reserve_hours   (this page writes it)
// Adding or removing a STEP is still a code change, because a step that no
// engine sends is not a step.

import { SEQUENCES, type SequenceId, type SequenceStep } from "../sequences/definitions.ts";

export type FlowId = "assignment" | "order_reachout" | "cold";

/** What the clock on a step is measured from, in the words the page shows.
 *  `fixed` steps have no wait of their own — they go out the moment the thing
 *  that triggers them happens, and their timing is the response window. */
export type WaitAnchor = "trigger" | "enrolled" | "engaged" | "prevStep" | "fixed";

export interface FlowStep {
  /** Stable id for this row, unique within the flow. */
  id: string;
  label: string;
  /** One line on when this fires — the page's subtitle for the step. */
  note: string;
  /** Registry message ids rendered for this step, in send order. The first is
   * what the subject-line field edits; the rest are companions on the same
   * touch (the SMS leg, the repeat-florist variant). */
  messageIds: string[];
  /** The sequence + step this row's wait time belongs to, when it has one.
   * Null on trigger/fixed steps — nothing to edit, and offering a box that
   * silently does nothing is worse than showing none. */
  timing: { sequenceId: SequenceId; stepKey: string; defaultDays: number } | null;
  anchor: WaitAnchor;
  channels: ("email" | "sms")[];
}

export interface FlowDef {
  id: FlowId;
  /** The sub-menu label. */
  label: string;
  /** The URL segment under /flows. */
  slug: string;
  /** What this funnel is for, in one sentence, above the steps. */
  blurb: string;
  /** True for the one funnel whose timing IS the response-window ladder, so
   * the page knows whether to show the window + cut-off card. */
  showsResponseWindow: boolean;
  steps: FlowStep[];
}

/** A sequence step, looked up by key, so the defaults on this page and the
 * defaults the metronome runs on come from one place. Throws rather than
 * defaulting: a typo here is a step whose editor writes a wait nothing reads,
 * which is exactly the failure this file exists to prevent. */
function seqStep(sequenceId: SequenceId, key: string): SequenceStep {
  const step = SEQUENCES[sequenceId].steps.find((s) => s.key === key);
  if (!step) throw new Error(`No step ${key} in sequence ${sequenceId}`);
  return step;
}

function timingFor(sequenceId: SequenceId, key: string) {
  // Steps may declare their wait in `hours` (the same-day recruiting funnel) or
  // `days`. /flows edits in DAYS — that is what `sequence_step_timing` stores
  // and what MIN/MAX_WAIT_DAYS validate — so a step's default is normalised to
  // days here rather than each caller guessing which field was set.
  const step = seqStep(sequenceId, key);
  const defaultDays = typeof step.hours === "number" ? step.hours / 24 : (step.days ?? 0);
  return { sequenceId, stepKey: key, defaultDays };
}

// ---- 1. Local florist assignment ----
//
// An order lands, we match shops already in the network, and offer it. There
// is no enrolment and no per-step wait: every touch fires on an event (matched,
// window lapsed, accepted). What staff actually tune here is the RESPONSE
// WINDOW ladder and the cut-off offset, which is why this is the one flow that
// shows them.
const ASSIGNMENT: FlowDef = {
  id: "assignment",
  label: "Local florist assignment",
  slug: "assignment",
  blurb:
    "An order we can place inside the network. We rank the florists near the delivery address and offer it to them one at a time, promoting the next-ranked shop each time a window lapses, until someone accepts or we run out of time and hand it to CX.",
  showsResponseWindow: true,
  steps: [
    {
      id: "offer",
      label: "The offer",
      note: "Sent the moment an order is matched to a shop. The repeat-florist variant differs only in its opening; the SMS leg goes out alongside the email when SMS offers are on.",
      messageIds: ["offer.full", "offer.short", "offer.sms"],
      timing: null,
      anchor: "trigger",
      channels: ["email", "sms"],
    },
    {
      id: "next_wave",
      label: "The next shop",
      note: "When the window lapses with no answer the offer is withdrawn and the next-ranked shop gets the same message. Its wait is the response window above, not a delay of its own.",
      messageIds: ["offer.full", "offer.sms"],
      timing: null,
      anchor: "fixed",
      channels: ["email", "sms"],
    },
    {
      id: "accept_confirm",
      label: "Accept confirmation",
      note: "The moment a florist takes the order, or CX takes it for them. Says thank you, what they are paid, and when it has to be there.",
      messageIds: ["acceptConfirm.email", "acceptConfirm.sms"],
      timing: null,
      anchor: "trigger",
      channels: ["email", "sms"],
    },
  ],
};

// ---- 2. "We have an order" reach-out ----
//
// The same real order, offered to a shop OUTSIDE the network — and, when that
// order goes elsewhere, the two emails that turn a lapsed cold offer into a
// recruiting conversation. Our strongest pitch, because it is the only one
// with a real order behind it.
const ORDER_REACHOUT: FlowDef = {
  id: "order_reachout",
  label: "“We have an order” reach-out",
  slug: "order-reachout",
  blurb:
    "A real order we could not place inside the network, offered to a shop that has never worked with us. If they take it they join on the spot; if the order goes elsewhere, two follow-ups say so and ask for the next one.",
  showsResponseWindow: false,
  steps: [
    {
      id: "cold_offer",
      label: "The cold offer",
      note: "The order itself, to a shop outside the network. The same email a member gets, with a join link in place of a sign-in link. Its response window is the ladder on Local florist assignment.",
      messageIds: ["offer.full", "offer.sms"],
      timing: null,
      anchor: "trigger",
      channels: ["email", "sms"],
    },
    {
      id: "co1",
      label: "Follow-up 1 — that order went elsewhere",
      note: "After the cold offer lapsed and the order was placed with someone else. From the market's persona, in plain voice.",
      messageIds: ["recruit.co1"],
      timing: timingFor("cold_offer_followup", "co1"),
      anchor: "enrolled",
      channels: ["email"],
    },
    {
      id: "co2",
      label: "Follow-up 2 — the next order",
      note: "The last word before the shop goes quiet. Counted from when follow-up 1 actually went out, not from the order.",
      messageIds: ["recruit.co2"],
      timing: timingFor("cold_offer_followup", "co2"),
      anchor: "prevStep",
      channels: ["email"],
    },
  ],
};

// ---- 3. Cold reach-out ----
//
// No order behind it. Three touches for a shop that never engages, and a
// separate two-step track the moment they click anything.
const COLD: FlowDef = {
  id: "cold",
  label: "Cold reach-out",
  slug: "cold",
  blurb:
    "A shop we found, with no order attached. Three touches if they never click, and the moment they do click, a different two-step conversation anchored to that click rather than to our calendar.",
  showsResponseWindow: false,
  steps: [
    {
      id: "t1",
      label: "Touch 1 — the situation",
      // Its wait is real but narrow, and the note has to say so. A staff send
      // from /discovery IS this touch — it is what enrols the shop — so there
      // is nothing to wait for. A shop the tick enrolled by itself is the
      // case the number governs.
      note: "Day 0. From Facundo, branded: the only touch in this funnel not signed by a person. Goes out with an SMS when recruiting SMS is on. Sending it from Discovery is what starts the funnel, so the wait below only applies to shops the engine enrols by itself after an ingest.",
      messageIds: ["recruit.t1", "recruit.sms.t1"],
      timing: timingFor("recruit_cold", "t1"),
      anchor: "enrolled",
      channels: ["email", "sms"],
    },
    {
      id: "t2",
      label: "Touch 2 — we're short here",
      note: "Only sent if they have not clicked anything. From the persona, plain voice.",
      messageIds: ["recruit.t2"],
      timing: timingFor("recruit_cold", "t2"),
      anchor: "enrolled",
      channels: ["email"],
    },
    {
      id: "t3",
      label: "Touch 3 — how the money works",
      note: "The last cold touch. After this the prospect goes to long-term nurture.",
      messageIds: ["recruit.t3"],
      timing: timingFor("recruit_cold", "t3"),
      anchor: "enrolled",
      channels: ["email"],
    },
    {
      id: "r1",
      label: "After a click — what stopped you?",
      note: "Counted from their FIRST click, not from enrolment: a shop that clicks on day 1 and one that clicks on day 6 get the same pause. The only touch that can honestly say they looked.",
      messageIds: ["recruit.r1", "recruit.sms.r1"],
      timing: timingFor("recruit_cold", "r1"),
      anchor: "engaged",
      channels: ["email", "sms"],
    },
    {
      id: "r2",
      label: "After a click — closing this off",
      note: "The graceful exit, counted from when the previous touch went out.",
      messageIds: ["recruit.r2"],
      timing: timingFor("recruit_cold", "r2"),
      anchor: "prevStep",
      channels: ["email"],
    },
  ],
};

export const FLOWS: FlowDef[] = [ASSIGNMENT, ORDER_REACHOUT, COLD];

export function flowBySlug(slug: string): FlowDef | undefined {
  return FLOWS.find((f) => f.slug === slug);
}

/** Every editable (sequenceId, stepKey) pair across every flow. The API
 * validates a wait-time write against this, so a step no funnel shows can
 * never be written from this page. */
export function editableTimingKeys(): { sequenceId: SequenceId; stepKey: string }[] {
  return FLOWS.flatMap((f) =>
    f.steps.flatMap((s) => (s.timing ? [{ sequenceId: s.timing.sequenceId, stepKey: s.timing.stepKey }] : []))
  );
}

/** What each message is called, everywhere it is named.
 *
 *  ONE list, because the funnel page and Wait time show the same chain and an
 *  operator moves between them to find the same email. They used to keep
 *  separate lists: Wait time said "Follow-up 2 — the next order" and the funnel
 *  page said "The next order", so the second email had two names and neither
 *  page told you it was the second. */
const MESSAGE_NAMES: Record<string, string> = {
  "offer.full": "The offer",
  "offer.short": "The offer, second version",
  "offer.sms": "The offer, by text",
  "acceptConfirm.email": "The thank-you",
  "acceptConfirm.sms": "The thank-you, by text",
  "recruit.co1": "That order went elsewhere",
  "recruit.co2": "The next order",
  "recruit.t1": "First email",
  "recruit.sms.t1": "First text",
  "recruit.t2": "We are short here",
  "recruit.t3": "How the money works",
  "recruit.r1": "After they click",
  "recruit.sms.r1": "After they click, by text",
  "recruit.r2": "Closing this off",
};

/** A message's name.
 *
 *  A DUPLICATE is a proper email in the chain, not a sub-item of the one it
 *  was copied from — so no "(copy)", which reads as a subsection. It takes its
 *  source's name with a number: "First email", "First email 2", "First email
 *  3". Naming every copy identically was the alternative, and three rows all
 *  called "First email" is worse than the thing being fixed. */
export function messageName(messageId: string): string {
  const known = MESSAGE_NAMES[messageId];
  if (known) return known;
  if (messageId.startsWith("recruit.")) {
    const stepKey = messageId.slice("recruit.".length);
    const source = MESSAGE_NAMES[`recruit.${sourceOfKey(stepKey)}`];
    if (source) {
      // `t1__copy1` is the SECOND email of that name, so the suffix is the
      // copy number plus one.
      const n = Number(stepKey.slice(stepKey.indexOf("__copy") + "__copy".length));
      return Number.isFinite(n) && n > 0 ? `${source} ${n + 1}` : source;
    }
  }
  return messageId;
}

/** Local copy of lib/flows/customSteps.ts::sourceOf. Duplicated rather than
 *  imported to keep this module's import graph one-directional — customSteps
 *  imports the sequence definitions, and a cycle through here would be a
 *  needless way to make both harder to test. */
function sourceOfKey(stepKey: string): string {
  const i = stepKey.indexOf("__copy");
  return i === -1 ? stepKey : stepKey.slice(0, i);
}

/** Where each message sits in the funnel's chain, 1-based.
 *
 *  The number is what makes the chain readable: "3." tells you this is the
 *  third thing we send, on the funnel page and on Wait time alike, so an
 *  operator can move between the two screens and land on the same email. */
export function chainPositions(flow: FlowDef): Record<string, number> {
  const out: Record<string, number> = {};
  listedMessageIds(flow).forEach((id, i) => {
    out[id] = i + 1;
  });
  return out;
}

/** The chain position of a funnel STEP, for Wait time — the number its first
 *  message carries on the funnel page. */
export function stepPosition(flow: FlowDef, step: FlowStep): number | null {
  const positions = chainPositions(flow);
  for (const id of step.messageIds) {
    if (positions[id] !== undefined) return positions[id];
  }
  return null;
}

/** The messages whose on/off switch is an `app_settings` column rather than a
 *  funnel step.
 *
 *  The assignment funnel has no scheduler — its emails fire on an event — so
 *  there is no step to switch off. What DOES exist is the per-kind toggle each
 *  send site already checks (lib/emailToggles.ts, lib/smsToggles.ts), and that
 *  is the honest switch for these rows: the same one Settings → Notifications
 *  shows, in the place you are actually thinking about the message.
 *
 *  `offer.short` is deliberately absent. It is not a separate send — it is the
 *  offer email with a different opening for a shop we have worked with — so a
 *  tick on it would either do nothing or silently mean "the offer", and both
 *  are worse than no tick. */
export const MESSAGE_TOGGLE_COLUMN: Record<string, string> = {
  "offer.full": "email_offer_enabled",
  // Unticking this does not stop an email — it stops the VARIANT, so a shop we
  // know gets the same opening as everyone else. The row is on the page, so it
  // needs a tick; a row with no tick also sits misaligned next to ones that
  // have one, which is how this was reported.
  "offer.short": "offer_short_variant_enabled",
  "offer.sms": "sms_offer_enabled",
  "acceptConfirm.email": "email_accept_confirm_enabled",
  "acceptConfirm.sms": "sms_accept_confirm_enabled",
};

/** An email and the text message that goes out with it are ONE message to a
 * person, so /flows shows them as one row with an Email/Text switch rather
 * than two rows. Only pairs that really are the same message on two channels
 * belong here — `offer.short` has no text twin, and inventing one would put a
 * switch on a row that cannot honour it. */
export const CHANNEL_SIBLINGS: Record<string, string> = {
  "offer.full": "offer.sms",
  "acceptConfirm.email": "acceptConfirm.sms",
  "recruit.t1": "recruit.sms.t1",
  "recruit.r1": "recruit.sms.r1",
};

/** The rows a funnel's message list shows: every message it sends, in send
 * order, minus the text twins that are folded into their email's switch. */
export function listedMessageIds(flow: FlowDef): string[] {
  const twins = new Set(Object.values(CHANNEL_SIBLINGS));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const step of flow.steps) {
    for (const id of step.messageIds) {
      if (twins.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** A funnel with its duplicates inserted, in send order — what /flows lists.
 *
 * The mirror of lib/flows/customSteps.ts::applyCustomSteps, which does the same
 * to the SequenceDef the engine runs. Two functions because they build two
 * different shapes (a page's step list vs. a scheduler's), over the same rows;
 * lib/flows/customSteps.test.mjs asserts they agree on which steps exist and in
 * what order, so the page can never show a funnel the engine does not send. */
export function withCustomSteps(
  flow: FlowDef,
  rows: readonly { sequence_id: string; step_key: string; source_step_key: string; after_step_key: string }[]
): FlowDef {
  const mine = rows.filter((r) => flow.steps.some((s) => s.timing?.sequenceId === r.sequence_id));
  if (mine.length === 0) return flow;

  let steps = [...flow.steps];
  let placed = true;
  while (placed) {
    placed = false;
    for (const row of mine) {
      if (steps.some((s) => s.timing?.stepKey === row.step_key)) continue;
      const afterIndex = steps.findIndex((s) => s.timing?.stepKey === row.after_step_key);
      const source = steps[afterIndex];
      if (afterIndex === -1 || !source?.timing) continue;
      const copy: FlowStep = {
        ...source,
        id: `${source.id}__copy_${row.step_key}`,
        label: `${source.label} (copy)`,
        note: "A duplicate of the message above. Its own words, its own wait, its own switch — editing the original leaves this one alone.",
        // The copy's message, under its own key. `recruit.<stepKey>` matches
        // how every other funnel touch is addressed.
        messageIds: [`recruit.${row.step_key}`],
        timing: { sequenceId: row.sequence_id as typeof source.timing.sequenceId, stepKey: row.step_key, defaultDays: 1 },
        anchor: "prevStep",
        channels: ["email"],
      };
      steps = [...steps.slice(0, afterIndex + 1), copy, ...steps.slice(afterIndex + 1)];
      placed = true;
    }
  }
  return { ...flow, steps };
}

/** `days` as the number + unit a person would say it in. 0.5 is twelve hours,
 * not "half a day", and a page that says the latter invites someone to type
 * 0.5 into a box labelled hours. */
export function humanWait(days: number): { value: number; unit: "hours" | "days" } {
  if (days === 0) return { value: 0, unit: "hours" };
  // A whole number of days stays in days — 3 is "3 days", never "72 hours" —
  // and anything else reads better in hours.
  if (Number.isInteger(days)) return { value: days, unit: "days" };
  return { value: Math.round(days * 24 * 100) / 100, unit: "hours" };
}

/** The inverse, for what the editor posts back. */
export function waitToDays(value: number, unit: "hours" | "days"): number {
  const days = unit === "hours" ? value / 24 : value;
  // Three decimals is the column's precision (numeric(7,3)); rounding here
  // rather than letting Postgres do it means what the page shows after a save
  // is what it stored.
  return Math.round(days * 1000) / 1000;
}
