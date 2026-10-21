import test from "node:test";
import assert from "node:assert/strict";
import { addonPrefix, lineItemKind, describeLineItem } from "./lineItemKind.ts";

// Barcodes below are real values from production order #2000018 and the
// aggregate scan documented in lineItemKind.ts.

test("addonPrefix pulls the type code out of an add-on barcode", () => {
  assert.equal(addonPrefix("FC-AD/CD30065_L"), "CD");
  assert.equal(addonPrefix("FC-AD/CM100109_U"), "CM");
});

test("addonPrefix returns null for the arrangement itself", () => {
  // The bouquet on #2000018 — no AD/ segment.
  assert.equal(addonPrefix("FC-FC2315FN_M"), null);
  assert.equal(addonPrefix("FC-FC1234_S"), null);
});

test("addonPrefix tolerates missing, blank and lowercase values", () => {
  assert.equal(addonPrefix(null), null);
  assert.equal(addonPrefix(undefined), null);
  assert.equal(addonPrefix("   "), null);
  assert.equal(addonPrefix("fc-ad/cd30065_l"), "CD");
});

test("every prefix seen in production maps to a label", () => {
  assert.equal(lineItemKind("FC-AD/CD30065_L"), "Greeting card");
  assert.equal(lineItemKind("FC-AD/CM100109_U"), "Vase");
  assert.equal(lineItemKind("FC-AD/VS4001_U"), "Vase");
  assert.equal(lineItemKind("FC-AD/CH0009_U"), "Chocolates");
  assert.equal(lineItemKind("FC-AD/BR0001_U"), "Teddy bear");
});

// A wrong label is worse than none for someone packing a box, so anything we
// haven't seen stays unlabelled rather than being guessed at.
test("an unrecognised prefix is left unlabelled rather than guessed", () => {
  assert.equal(lineItemKind("FC-AD/ZZ9999_U"), null);
  assert.equal(lineItemKind("FC-FC2315FN_M"), null);
  assert.equal(lineItemKind(null), null);
});

test("describeLineItem prefixes the kind, exactly as the offer page shows it", () => {
  assert.equal(describeLineItem("I Love You", "FC-AD/CD30065_L"), "Greeting card · I Love You");
  assert.equal(describeLineItem("Sandy", "FC-AD/CM100109_U"), "Vase · Sandy");
  assert.equal(describeLineItem("Lindt Mini Pralines", "FC-AD/CH0009_U"), "Chocolates · Lindt Mini Pralines");
});

test("describeLineItem falls back to the bare title when the kind is unknown", () => {
  assert.equal(describeLineItem("Roses's Elegance", "FC-FC2315FN_M"), "Roses's Elegance");
  assert.equal(describeLineItem("Mystery Item", null), "Mystery Item");
});

test("describeLineItem doesn't repeat a kind the title already states", () => {
  assert.equal(describeLineItem("Glass Vase", "FC-AD/VS4001_U"), "Glass Vase");
  assert.equal(describeLineItem("greeting card", "FC-AD/CD30065_L"), "greeting card");
});

test("describeLineItem copes with a missing title", () => {
  assert.equal(describeLineItem(null, "FC-AD/CD30065_L"), "Greeting card");
  assert.equal(describeLineItem("", null), "");
});
