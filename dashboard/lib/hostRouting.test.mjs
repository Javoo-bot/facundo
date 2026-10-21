// Sanity assertions for the host->surface split. Both failure directions are
// silent in production (over-blocking 404s a page florists need; under-blocking
// leaves the backoffice reachable on the florist hostname), hence the exception
// to the "barely any tests" non-goal.
//   node --test lib/hostRouting.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideHostRoute,
  normalizeHost,
  firstSegment,
  floristAppUrl,
  sharedCookieDomain,
  STAFF_SEGMENTS,
  FLORIST_HOST,
  BACKOFFICE_HOST,
} from "./hostRouting.ts";

test("normalizeHost strips port and casing, tolerates null", () => {
  assert.equal(normalizeHost("Florist.Fc.example.net:443"), "florist.fc.example.net");
  assert.equal(normalizeHost("  bo.fc.example.net  "), "bo.fc.example.net");
  assert.equal(normalizeHost(null), "");
  assert.equal(normalizeHost(undefined), "");
});

test("firstSegment handles root, nested and trailing slashes", () => {
  assert.equal(firstSegment("/"), "");
  assert.equal(firstSegment("/orders"), "orders");
  assert.equal(firstSegment("/orders/abc-123"), "orders");
  assert.equal(firstSegment("/florist/"), "florist");
});

test("unknown hosts pass everything through — legacy + local dev must not break", () => {
  for (const host of ["facundo.example.org", "facundo-staging.example.org", "localhost:3001", ""]) {
    for (const path of ["/", "/orders", "/florist", "/settings", "/florist/login"]) {
      assert.deepEqual(decideHostRoute(host, path), { kind: "pass" }, `${host}${path}`);
    }
  }
});

test("florist host: root redirects to the PWA", () => {
  assert.deepEqual(decideHostRoute(FLORIST_HOST, "/"), { kind: "redirect", to: "/florist" });
});

test("florist host: every staff segment 404s", () => {
  for (const seg of STAFF_SEGMENTS) {
    assert.deepEqual(decideHostRoute(FLORIST_HOST, `/${seg}`), { kind: "not-found" }, `/${seg}`);
    assert.deepEqual(decideHostRoute(FLORIST_HOST, `/${seg}/deep/path`), { kind: "not-found" }, `/${seg}/deep`);
  }
});

// The public Q&A (app/help) is what the offer and recruiting emails link to,
// and those land on the florist host. Adding "help" to STAFF_SEGMENTS would
// 404 a link already sitting in florists' inboxes, so it is pinned here — the
// staff-side editor deliberately lives at /faq instead.
test("florist host: the public Q&A stays reachable", () => {
  assert.ok(!STAFF_SEGMENTS.has("help"), "/help must not be a staff segment — the editor is /faq");
  assert.deepEqual(decideHostRoute(FLORIST_HOST, "/help"), { kind: "pass" });
  assert.deepEqual(decideHostRoute(FLORIST_HOST, "/help?locale=es"), { kind: "pass" });
  assert.deepEqual(decideHostRoute(FLORIST_HOST, "/faq"), { kind: "not-found" });
});

test("florist host: PWA, auth and shared paths pass", () => {
  for (const path of [
    "/florist",
    "/florist/login",
    "/florist/orders/abc",
    "/florist/join",
    "/florist/unsubscribe/tok",
    "/auth/reset",
    "/auth/callback",
    "/api/florist/photo",
    "/api/orders/proof", // customer proof link must work on the store domain
    "/_next/data/x.json",
  ]) {
    assert.deepEqual(decideHostRoute(FLORIST_HOST, path), { kind: "pass" }, path);
  }
});

test("backoffice host: florist PWA 404s, staff console passes", () => {
  assert.deepEqual(decideHostRoute(BACKOFFICE_HOST, "/florist"), { kind: "not-found" });
  assert.deepEqual(decideHostRoute(BACKOFFICE_HOST, "/florist/login"), { kind: "not-found" });
  for (const path of ["/", "/orders", "/settings", "/payments", "/auth/reset"]) {
    assert.deepEqual(decideHostRoute(BACKOFFICE_HOST, path), { kind: "pass" }, path);
  }
});

test("backoffice host: florist API routes still reachable (auth is the boundary, not the host)", () => {
  assert.deepEqual(decideHostRoute(BACKOFFICE_HOST, "/api/florist/photo"), { kind: "pass" });
  assert.deepEqual(decideHostRoute(BACKOFFICE_HOST, "/api/staff/view-as"), { kind: "pass" });
});

test("floristAppUrl: absolute to the florist host from the backoffice host, relative everywhere else", () => {
  assert.equal(floristAppUrl(BACKOFFICE_HOST), `https://${FLORIST_HOST}/florist`);
  assert.equal(floristAppUrl(FLORIST_HOST), "/florist");
  for (const host of ["facundo.example.org", "localhost:3000", null, undefined]) {
    assert.equal(floristAppUrl(host), "/florist");
  }
});

// The public Q&A renders on every host, including the backoffice one — that's
// where staff open it to preview an edit. Its "see how an order works" link
// points into /florist/**, which IS 404'd there, so a relative href is a broken
// link on exactly the host staff use. app/help/page.tsx composes it through
// floristAppUrl; this pins the composition, not just the helper.
test("the Q&A's how-it-works link survives being rendered on the backoffice host", () => {
  const href = (host) => `${floristAppUrl(host)}/how-it-works?locale=es`;
  assert.equal(href(BACKOFFICE_HOST), `https://${FLORIST_HOST}/florist/how-it-works?locale=es`);
  assert.deepEqual(decideHostRoute(FLORIST_HOST, "/florist/how-it-works"), { kind: "pass" });
  // Everywhere else it stays relative, and resolves on that same host.
  for (const host of [FLORIST_HOST, "facundo.example.org", "localhost:3001"]) {
    assert.equal(href(host), "/florist/how-it-works?locale=es");
  }
});

test("sharedCookieDomain: only the two production hosts get the shared domain", () => {
  assert.equal(sharedCookieDomain(BACKOFFICE_HOST), ".fc.example.net");
  assert.equal(sharedCookieDomain(FLORIST_HOST), ".fc.example.net");
  assert.equal(sharedCookieDomain("Bo.Fc.example.net:443"), ".fc.example.net");
  for (const host of ["facundo.example.org", "localhost:3000", null, undefined]) {
    assert.equal(sharedCookieDomain(host), undefined);
  }
});

test("'florists' (staff, plural) and '/florist' (PWA, singular) are not confused", () => {
  assert.deepEqual(decideHostRoute(FLORIST_HOST, "/florists"), { kind: "not-found" });
  assert.deepEqual(decideHostRoute(FLORIST_HOST, "/florist"), { kind: "pass" });
  assert.deepEqual(decideHostRoute(BACKOFFICE_HOST, "/florists"), { kind: "pass" });
  assert.deepEqual(decideHostRoute(BACKOFFICE_HOST, "/florist"), { kind: "not-found" });
});

// Short links (dashboard/app/[code]/route.ts) are root-mounted on the BACKOFFICE
// host. Nothing special routes them — they pass because a 10-char code is not a
// staff segment and not a /florist path — so assert that invariant directly.
test("a root-mounted short code passes on the backoffice host", () => {
  assert.deepEqual(decideHostRoute(BACKOFFICE_HOST, "/aB3xK9mQ2p"), { kind: "pass" });
  // And the staff console still owns its own routes, which is what makes the
  // generation-time collision guard (lib/shortLink.ts) load-bearing.
  for (const seg of STAFF_SEGMENTS) {
    assert.deepEqual(decideHostRoute(BACKOFFICE_HOST, `/${seg}`), { kind: "pass" },
      `staff segment ${seg} must still route to the console`);
  }
});
