import test from "node:test";
import assert from "node:assert/strict";
import { sniffImageMedia, extensionFor, mediaTypeMismatch } from "./imageType.ts";

const bytes = (...b) => new Uint8Array(b);
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));

test("recognises a JPEG by its SOI marker", () => {
  assert.equal(sniffImageMedia(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10)), "image/jpeg");
  assert.equal(sniffImageMedia(bytes(0xff, 0xd8, 0xff, 0xe1)), "image/jpeg"); // EXIF variant
});

test("recognises a PNG by its 8-byte signature", () => {
  assert.equal(sniffImageMedia(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00)), "image/png");
});

test("recognises a WebP by RIFF....WEBP", () => {
  const b = bytes(...ascii("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ascii("WEBPVP8 "));
  assert.equal(sniffImageMedia(b), "image/webp");
});

test("RIFF that is not WEBP is not an image we accept (e.g. a WAV)", () => {
  const wav = bytes(...ascii("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ascii("WAVEfmt "));
  assert.equal(sniffImageMedia(wav), null);
});

test("unknown / truncated bytes sniff as null rather than guessing JPEG", () => {
  // This is THE regression: normMedia() used to treat anything not-png/not-webp
  // as image/jpeg, so a WebP announced as JPEG went to Anthropic as JPEG and
  // came back a 400 the florist saw as an unexplained hold.
  assert.equal(sniffImageMedia(bytes()), null);
  assert.equal(sniffImageMedia(bytes(0xff)), null);
  assert.equal(sniffImageMedia(bytes(0xff, 0xd8)), null); // JPEG needs three bytes
  assert.equal(sniffImageMedia(bytes(0x00, 0x00, 0x00, 0x18, ...ascii("ftypheic"))), null); // HEIC
  assert.equal(sniffImageMedia(bytes(...ascii("%PDF-1.4"))), null);
});

test("accepts an ArrayBuffer as well as a Uint8Array", () => {
  const u8 = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  assert.equal(sniffImageMedia(u8.buffer), "image/png");
});

test("the extension always matches the media type", () => {
  assert.equal(extensionFor("image/jpeg"), "jpg");
  assert.equal(extensionFor("image/png"), "png");
  assert.equal(extensionFor("image/webp"), "webp");
});

test("mismatch reports the exact case that broke QA: WebP bytes declared as JPEG", () => {
  assert.equal(mediaTypeMismatch("image/jpeg", "image/webp"), true);
  assert.equal(mediaTypeMismatch("IMAGE/JPEG", "image/jpeg"), false); // case-insensitive
  assert.equal(mediaTypeMismatch("", "image/jpeg"), true);
  assert.equal(mediaTypeMismatch(null, "image/png"), true);
});
