import test from "node:test";
import assert from "node:assert/strict";

import {
  FLOWS,
  flowBySlug,
  editableTimingKeys,
  humanWait,
  waitToDays,
  listedMessageIds,
  CHANNEL_SIBLINGS,
  chainPositions,
  stepPosition,
  messageName,
  withCustomSteps,
} from "./catalog.ts";
import { SEQUENCES } from "../sequences/definitions.ts";
import { MESSAGES } from "../messages/registry.ts";

const MESSAGE_IDS = new Set(MESSAGES.map((m) => m.id));

test("every step points at messages that actually exist", () => {
  // The failure this catches: a funnel row whose editor renders nothing, or
  // worse, whose "Send test" 404s — a page that claims to be the map of what
  // we send has to be checkable against what we send.
  for (const flow of FLOWS) {
    for (const step of flow.steps) {
      assert.ok(step.messageIds.length > 0, `${flow.id}/${step.id} shows no message`);
      for (const id of step.messageIds) {
        assert.ok(MESSAGE_IDS.has(id), `${flow.id}/${step.id} points at unknown message ${id}`);
      }
    }
  }
});

test("every editable wait points at a real sequence step, with the real default", () => {
  for (const flow of FLOWS) {
    for (const step of flow.steps) {
      if (!step.timing) continue;
      const def = SEQUENCES[step.timing.sequenceId];
      assert.ok(def, `${flow.id}/${step.id} names unknown sequence ${step.timing.sequenceId}`);
      const real = def.steps.find((s) => s.key === step.timing.stepKey);
      assert.ok(real, `${flow.id}/${step.id} names unknown step ${step.timing.stepKey}`);
      // The number shown as "the built-in wait" has to BE the built-in wait,
      // or the reset button lies about what it resets to. Steps may declare
      // `hours` (the same-day recruiting funnel) or `days`; /flows edits in
      // days, so compare against the step's real wait normalised to days.
      const realDays = typeof real.hours === "number" ? real.hours / 24 : (real.days ?? 0);
      assert.equal(step.timing.defaultDays, realDays, `${flow.id}/${step.id} default drifted`);
    }
  }
});

test("a step's declared anchor matches the sequence step's own anchor", () => {
  for (const flow of FLOWS) {
    for (const step of flow.steps) {
      if (!step.timing) continue;
      const real = SEQUENCES[step.timing.sequenceId].steps.find((s) => s.key === step.timing.stepKey);
      // "3 days after what" is the whole question, and the page prints the
      // answer under the box. If it printed the wrong one, the number would be
      // edited correctly and mean something else.
      assert.equal(step.anchor, real.anchor, `${flow.id}/${step.id} anchor drifted`);
    }
  }
});

test("a step's declared channels match the sequence step's own channels", () => {
  for (const flow of FLOWS) {
    for (const step of flow.steps) {
      if (!step.timing) continue;
      const real = SEQUENCES[step.timing.sequenceId].steps.find((s) => s.key === step.timing.stepKey);
      assert.deepEqual([...step.channels].sort(), [...real.channels].sort(), `${flow.id}/${step.id} channels drifted`);
    }
  }
});

test("both sequence-backed funnels show every step of their sequence", () => {
  // A funnel view that quietly omits a touch is worse than no funnel view: it
  // reads as "these are all the emails we send" and it isn't.
  const shown = (sequenceId) =>
    new Set(
      FLOWS.flatMap((f) => f.steps)
        .filter((s) => s.timing?.sequenceId === sequenceId)
        .map((s) => s.timing.stepKey)
    );

  for (const sequenceId of ["recruit_cold", "cold_offer_followup"]) {
    const expected = SEQUENCES[sequenceId].steps.map((s) => s.key).sort();
    assert.deepEqual([...shown(sequenceId)].sort(), expected, `${sequenceId} is not fully shown`);
  }
});

test("slugs and ids are unique, and every slug resolves", () => {
  const slugs = FLOWS.map((f) => f.slug);
  const ids = FLOWS.map((f) => f.id);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.equal(new Set(ids).size, ids.length);
  for (const f of FLOWS) {
    assert.equal(flowBySlug(f.slug), f);
    // Step ids are the React keys and the only handle a bug report has.
    const stepIds = f.steps.map((s) => s.id);
    assert.equal(new Set(stepIds).size, stepIds.length, `${f.id} has duplicate step ids`);
  }
  assert.equal(flowBySlug("nope"), undefined);
});

test("exactly one funnel owns the response window", () => {
  assert.equal(FLOWS.filter((f) => f.showsResponseWindow).length, 1);
  assert.equal(FLOWS.find((f) => f.showsResponseWindow).id, "assignment");
});

test("editableTimingKeys covers every editable step and nothing else", () => {
  const keys = editableTimingKeys();
  const fromFlows = FLOWS.flatMap((f) => f.steps).filter((s) => s.timing);
  assert.equal(keys.length, fromFlows.length);
  for (const k of keys) {
    assert.ok(SEQUENCES[k.sequenceId].steps.some((s) => s.key === k.stepKey));
  }
});

test("humanWait says hours for anything that isn't whole days", () => {
  assert.deepEqual(humanWait(0), { value: 0, unit: "hours" });
  assert.deepEqual(humanWait(0.5), { value: 12, unit: "hours" });
  assert.deepEqual(humanWait(3), { value: 3, unit: "days" });
  assert.deepEqual(humanWait(0.25), { value: 6, unit: "hours" });
});

test("waitToDays round-trips through humanWait", () => {
  for (const days of [0, 0.25, 0.5, 1, 3, 4, 7, 10]) {
    const h = humanWait(days);
    assert.equal(waitToDays(h.value, h.unit), days, `${days} did not round-trip`);
  }
});

test("waitToDays stays inside the column's precision", () => {
  // numeric(7,3). An hours value that cannot be expressed in three decimals
  // must round HERE, so the page shows what the database stored rather than
  // what the box said a moment ago.
  assert.equal(waitToDays(1, "hours"), 0.042);
  assert.equal(waitToDays(36, "hours"), 1.5);
});

test("every channel sibling is a real pair: an email and its text twin", () => {
  for (const [emailId, smsId] of Object.entries(CHANNEL_SIBLINGS)) {
    const email = MESSAGES.find((m) => m.id === emailId);
    const sms = MESSAGES.find((m) => m.id === smsId);
    assert.ok(email, `${emailId} is not a message`);
    assert.ok(sms, `${smsId} is not a message`);
    // A switch labelled Email/Text that flips to another email, or to a text
    // that is a different message, is worse than two honest rows.
    assert.equal(email.channel, "email", `${emailId} is not an email`);
    assert.equal(sms.channel, "sms", `${smsId} is not a text message`);
  }
});

test("no message is both a listed row and somebody's text twin", () => {
  const twins = new Set(Object.values(CHANNEL_SIBLINGS));
  for (const emailId of Object.keys(CHANNEL_SIBLINGS)) {
    assert.ok(!twins.has(emailId), `${emailId} is both a row and a twin`);
  }
});

test("listedMessageIds folds the twins away and keeps everything else, once", () => {
  const twins = new Set(Object.values(CHANNEL_SIBLINGS));
  for (const flow of FLOWS) {
    const listed = listedMessageIds(flow);
    assert.equal(new Set(listed).size, listed.length, `${flow.id} lists something twice`);
    for (const id of listed) {
      assert.ok(!twins.has(id), `${flow.id} lists ${id}, which is a text twin`);
    }
    // Nothing the funnel sends may vanish: every message is either a row, or
    // reachable behind the Email/Text switch on its own email's row.
    const reachable = new Set(listed.flatMap((id) => [id, CHANNEL_SIBLINGS[id]].filter(Boolean)));
    for (const step of flow.steps) {
      for (const id of step.messageIds) {
        assert.ok(reachable.has(id), `${flow.id}/${step.id}: ${id} is not reachable from the list`);
      }
    }
  }
});

test("Local florist assignment lists exactly the three the team names", () => {
  const assignment = FLOWS.find((f) => f.id === "assignment");
  assert.deepEqual(listedMessageIds(assignment), ["offer.full", "offer.short", "acceptConfirm.email"]);
});

test("Wait time and the funnel page name the same email the same way", () => {
  // Reported 2026-09-04: Wait time said "Follow-up 2 — the next order" and the
  // funnel page said "The next order", so the second email had two names and
  // neither page told you it was the second. One list, one number, both pages.
  for (const flow of FLOWS) {
    const positions = chainPositions(flow);
    for (const step of flow.steps) {
      if (!step.timing) continue; // not on Wait time
      const onWaitTime = `${stepPosition(flow, step)}. ${messageName(step.messageIds[0])}`;
      const onFunnel = `${positions[step.messageIds[0]]}. ${messageName(step.messageIds[0])}`;
      assert.equal(onWaitTime, onFunnel, `${flow.id}/${step.id} is named two ways`);
      assert.ok(!onWaitTime.startsWith("?"), `${flow.id}/${step.id} has no chain position`);
    }
  }
});

test("the chain is numbered 1..n with no gaps and no repeats", () => {
  for (const flow of FLOWS) {
    const nums = Object.values(chainPositions(flow)).sort((a, b) => a - b);
    assert.deepEqual(nums, nums.map((_, i) => i + 1), `${flow.id} is not a clean 1..n chain`);
  }
});

test("a duplicate is a proper email in the chain, not a sub-item", () => {
  const cold = FLOWS.find((f) => f.id === "cold");
  const withCopy = withCustomSteps(cold, [
    { sequence_id: "recruit_cold", step_key: "t2__copy1", source_step_key: "t2", after_step_key: "t2" },
  ]);
  const positions = chainPositions(withCopy);
  // It takes its own number in the chain, directly after the one it copied.
  assert.equal(positions["recruit.t2__copy1"], positions["recruit.t2"] + 1);
  // Its own name, built from its source's — "We are short here 2". Not
  // "(copy)", which reads as a subsection of the original, and not the same
  // name twice, which makes two rows indistinguishable.
  assert.equal(messageName("recruit.t2__copy1"), messageName("recruit.t2") + " 2");
  assert.equal(messageName("recruit.t2__copy2"), messageName("recruit.t2") + " 3");
  assert.ok(!messageName("recruit.t2__copy1").includes("copy"));
  assert.notEqual(messageName("recruit.t2__copy1"), messageName("recruit.t2"));
  // Everything after it renumbers, so the chain still reads 1..n.
  const nums = Object.values(positions).sort((a, b) => a - b);
  assert.deepEqual(nums, nums.map((_, i) => i + 1));
});

test("Wait time can show every funnel and every email in its chain", () => {
  // Reported 2026-09-04: Local florist assignment had no entry on Wait time at
  // all, and "1. The offer" was missing from the "We have an order" chapter —
  // because that page listed only steps with an editable wait, and both of
  // those fire on an event. Wait time lists the chain; a row with no number to
  // set says what governs it instead.
  for (const flow of FLOWS) {
    const ids = listedMessageIds(flow);
    assert.ok(ids.length > 0, `${flow.id} has no chain to show`);
    for (const id of ids) {
      // Every listed message must belong to a step, or the page has a row it
      // cannot explain.
      const step = flow.steps.find((s) => s.messageIds.includes(id));
      assert.ok(step, `${flow.id}: ${id} belongs to no step`);
      // And it is either editable, or it is governed by something nameable.
      assert.ok(
        step.timing !== null || step.anchor === "trigger" || step.anchor === "fixed",
        `${flow.id}: ${id} has neither a wait nor a reason it has none`
      );
    }
  }

  // The funnel that owns the answer window is the one that shows it.
  const assignment = FLOWS.find((f) => f.id === "assignment");
  assert.equal(assignment.showsResponseWindow, true);
  assert.ok(listedMessageIds(assignment).includes("offer.full"), "the offer is on the assignment chain");
  // …and "We have an order" opens with that same offer email.
  const reachout = FLOWS.find((f) => f.id === "order_reachout");
  assert.equal(listedMessageIds(reachout)[0], "offer.full");
});
