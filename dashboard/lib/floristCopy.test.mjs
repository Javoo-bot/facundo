import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// ---- house style: no em dashes in anything a florist or a customer reads ----
//
// lib/i18n/i18n.test.mjs already guards the catalogs, which is where the great
// majority of that copy lives. This covers the rest: strings written straight
// into the florist PWA and the public Q&A. They are just as visible and were
// never checked — a sweep found eight, including the payout split on every
// offer ("70% — when you accept").
//
// Customer-facing copy is entirely catalog-resident (`email.client.*`), so it
// is covered by the other guard rather than repeated here.
//
// Comments are exempt: this codebase uses em dashes in prose comments
// throughout, deliberately, and none of it ships.
//
// A LONE "—" is also exempt. It is the conventional glyph for "no value" in a
// table cell or a stat tile ("Rating —"), not a sentence, and it is never sent
// over SMS where U+2014 would cost a segment. What this bans is an em dash used
// as PUNCTUATION: one with text on either side.

const ROOTS = [
  "components/florist",
  "components/help",
  "app/florist",
  "app/help",
];

/**
 * Files under those roots that NO florist ever sees, with the reason. Both of
 * these sit in `components/florist/` because they are ABOUT a florist, and are
 * rendered only by the staff page `app/(staff)/florists/[id]` — a naming trap
 * worth writing down rather than quietly passing over.
 *
 * The list is checked for rot below: an entry that no longer exists fails.
 */
const STAFF_ONLY = new Map([
  ["components/florist/FloristCardClient.tsx", "the backoffice florist card (app/(staff)/florists/[id])"],
  ["components/florist/ActivityTimeline.tsx", "outreach history on that same staff card"],
]);

/** Every .ts/.tsx file under `dir`, tests excluded.
 *
 * Paths are normalised to forward slashes. `path.join` emits "\" on Windows, so
 * without this the STAFF_ONLY keys above (written with "/", as they appear in
 * every other reference in this repo) never matched and both exempted staff
 * files were reported as offences — a failure that only ever showed on a Windows
 * checkout, never in CI. */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) sourceFiles(file, out);
    else if (/\.tsx?$/.test(file) && !/\.test\./.test(file)) out.push(file.split(path.sep).join("/"));
  }
  return out;
}

/** Blanks out line, block and JSX comments, preserving line numbers. */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("//", i)) {
      const end = src.indexOf("\n", i);
      if (end === -1) break;
      out += " ".repeat(end - i);
      i = end;
    } else if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) break;
      out += src.slice(i, end + 2).replace(/[^\n]/g, " ");
      i = end + 2;
    } else if (src.startsWith("{/*", i)) {
      const end = src.indexOf("*/}", i);
      if (end === -1) { out += src[i]; i += 1; }
      else { out += src.slice(i, end + 3).replace(/[^\n]/g, " "); i = end + 3; }
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

test("no em dash punctuation in florist-facing source", () => {
  const offences = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      if (STAFF_ONLY.has(file)) continue;
      stripComments(readFileSync(file, "utf8"))
        .split("\n")
        .forEach((line, n) => {
          // Text on BOTH sides of the dash = punctuation, not a placeholder.
          if (/\S[^\n]*—[^\n]*\S/.test(line.replace(/"—"|'—'|>—</g, ""))) {
            offences.push(`${file}:${n + 1}: ${line.trim()}`);
          }
        });
    }
  }
  assert.deepEqual(offences, [], `em dash used as punctuation:\n${offences.join("\n")}`);
});

test("every staff-only exemption still exists", () => {
  for (const [file, why] of STAFF_ONLY) {
    assert.ok(statSync(file).isFile(), `${file} is exempted (${why}) but no longer exists — drop the entry`);
  }
});

test("the scan reads code but not comments, and tolerates the empty-value glyph", () => {
  const src = [
    "// a comment with an em dash — allowed",
    "/* block — allowed */",
    'const empty = "—";                       // lone glyph, allowed',
    'const prose = "we pay you — before you deliver";',
  ].join("\n");
  const lines = stripComments(src).split("\n");
  const flagged = lines.filter((l) => /\S[^\n]*—[^\n]*\S/.test(l.replace(/"—"|'—'|>—</g, "")));
  assert.equal(flagged.length, 1);
  assert.match(flagged[0], /before you deliver/);
});
