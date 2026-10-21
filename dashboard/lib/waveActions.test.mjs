import test from "node:test";
import assert from "node:assert/strict";
import { nextOfferAction } from "./waveActions.ts";

test("nextOfferAction: manual always skips (humans drive every send)", () => {
  assert.equal(nextOfferAction("manual"), "skip");
});

test("nextOfferAction: semi always files an approval", () => {
  assert.equal(nextOfferAction("semi"), "file");
});

test("nextOfferAction: auto always sends — including to a prospect, since this decision never looks at lifecycle stage", () => {
  assert.equal(nextOfferAction("auto"), "send");
});
