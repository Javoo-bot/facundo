// Drive the REAL staging APIs as a real signed-in florist.
//
//   node scripts/act-as.mjs florist <floristId> [METHOD] [path] [jsonBody]
//
// WHY. Everything downstream of "the florist opens the offer" is behind a
// session: /api/florist/* wants a florist cookie. Without a way to hold one, a
// test can only inspect the database and guess at what the buttons would have
// done — which is exactly the kind of test that passes while the product is
// broken.
//
// The session is not faked. It is minted the way the product mints it: a row in
// `florist_magic_tokens`, exactly as lib/floristMagicLinkMint.ts writes one,
// then a GET to /florist/m/<token> — the route the offer email's button points
// at. That route calls verifyOtp and writes the real session cookies.
//
// Minting our own is necessary rather than convenient: a test-mode offer to a
// real shop deliberately carries an INERT token
// (lib/floristMagicLink.ts::TEST_MODE_MAGIC_TOKEN), because the emailed link is
// a login to a real business landing in a shared staff inbox. Minting here
// exercises the florist's half of the loop without ever putting a live
// credential into an inbox.
//
// STAFF SIGN-IN IS NOT POSSIBLE HEADLESSLY, and that is not a bug worth fixing:
// /auth/callback does a PKCE `exchangeCodeForSession`, and the code verifier
// cookie only exists in the browser that began the flow. Following an
// admin-generated magic link from a script lands on `/?error=signin_incomplete`
// — verified, not assumed. Staff-side steps have to be clicked by a person.
//
// Uses Node's own fetch, not curl. An earlier version shelled out and Git Bash's
// MSYS layer rewrote curl's argv, appending a drive letter to the request URL,
// so the call never left the machine and reported a DNS failure for a host that
// resolves perfectly. No shell means no path conversion and no quoting rules.

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

export const BASE = process.env.STAGING_URL ?? "https://facundo-staging.example.org";
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** A cookie jar: name -> value. */
export function newJar() {
  return new Map();
}

function applySetCookies(jar, res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const pair = raw.split(";")[0];
    const i = pair.indexOf("=");
    if (i < 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    // An expiry in the past is a deletion; honour it, or a stale session cookie
    // outlives the sign-out that removed it.
    if (/max-age=0/i.test(raw) || value === "") jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar) {
  const parts = [];
  for (const [k, v] of jar.entries()) parts.push(k + "=" + v);
  return parts.join("; ");
}

/**
 * fetch that carries the jar and follows redirects BY HAND.
 *
 * Automatic following swallows the headers of intermediate hops, and the
 * session is established on exactly such a hop — the magic-link route sets its
 * cookies on the redirect that then sends you to the order page.
 */
export async function hop(jar, url, init = {}, maxHops = 10) {
  let current = url;
  let step = init;
  for (let i = 0; i < maxHops; i++) {
    const headers = Object.assign({}, step.headers || {});
    const cookie = cookieHeader(jar);
    if (cookie) headers.cookie = cookie;
    const res = await fetch(current, Object.assign({}, step, { headers, redirect: "manual" }));
    applySetCookies(jar, res);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      step = { method: "GET" }; // a redirect is a GET from here on
      continue;
    }
    return { status: res.status, url: current, res };
  }
  return { status: 0, url: current, res: null };
}

/** Mint a florist magic token, redeem it, and return a jar holding the session. */
export async function floristSession(floristId, dest = "/florist") {
  const jar = newJar();
  const token = randomBytes(24).toString("base64url");
  const { error } = await db.from("florist_magic_tokens").insert({
    token,
    florist_id: floristId,
    dest,
    purpose: "qa-placement-test",
    expires_at: new Date(Date.now() + 6 * 3600e3).toISOString(),
  });
  if (error) throw new Error("mint token: " + error.message);
  const landed = await hop(jar, BASE + "/florist/m/" + token);
  return { jar, token, landed: landed.status + " " + landed.url };
}

/** One authenticated request. Returns { code, body }. */
export async function call(jar, method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await hop(jar, BASE + path, init);
  const text = r.res ? await r.res.text() : "";
  return { code: r.status, body: text };
}

/**
 * Recover the API path from what the shell actually handed us.
 *
 * Git Bash's MSYS layer rewrites any argument that looks like a Unix absolute
 * path into a Windows one: `/api/florist/respond` arrives as
 * `C:/Program Files/Git/api/florist/respond`. Concatenated onto the base URL
 * that yields `https://host.comC:/Program Files/...`, whose hostname parses as
 * `host.comc` — a DNS failure for a host that resolves perfectly, which is a
 * genuinely baffling error to read.
 *
 * So: pass the path WITHOUT a leading slash (`api/florist/respond`) and this
 * adds it back. A mangled absolute path is also recovered, for the case where
 * someone types the slash out of habit.
 */
export function cleanPath(p) {
  if (!p) return p;
  const mangled = p.match(/^[A-Za-z]:[\\/].*?(\/(?:api|florist|orders|auth)\/.*)$/);
  if (mangled) return mangled[1];
  return p.startsWith("/") ? p : "/" + p;
}

// -- CLI --------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("act-as.mjs")) {
  const who = process.argv[2];
  const rest = process.argv.slice(3);
  if (who === "florist") {
    const floristId = rest[0];
    const method = rest[1];
    const path = cleanPath(rest[2]);
    const json = rest[3];
    const session = await floristSession(floristId);
    console.log("signed in -> " + session.landed);
    if (method) {
      const r = await call(session.jar, method, path, json ? JSON.parse(json) : undefined);
      console.log(r.code + "  " + r.body.slice(0, 800));
    }
  } else {
    console.log("usage: act-as.mjs florist <floristId> [METHOD] [path] [json]");
    console.log("staff sign-in is not possible headlessly - /auth/callback does a PKCE");
    console.log("exchange and the verifier cookie only exists in the browser that started it.");
  }
}
