import { requireRole } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { isLocale, flattenKeys, type Locale } from "@/lib/i18n";
import { sanitizeRichText } from "@/lib/messages/richText";
import { parseBlocks, serializeBlocks } from "@/lib/messages/blocks";
import { COPY_MARKER, sourceOf } from "@/lib/flows/customSteps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Draft storage for the message editor.
//
// message_overrides — what every send site reads — is only ever written by the
// `publish` action here. Everything else touches message_override_drafts, so a
// half-finished edit cannot reach a florist.
//
//   GET    ?locale=xx        list this locale's drafts
//   POST   {save}            upsert one draft (value "" deletes it)
//   POST   {publish}         move drafts into message_overrides — every draft
//                            for the locale, or only `keys` when given
//   POST   {discard}         drop every draft for the locale
//   POST   {revert}          undo ONE message: its drafts, and optionally its
//                            live overrides (= back to the built-in wording)

const VALID_KEYS = new Set(flattenKeys());

/** Is this a key we are willing to write?
 *
 * A DUPLICATE's keys (`email.recruit.t2__copy1.subject`) are not in the
 * catalog — the copy was created at runtime — but they are exactly a catalog
 * key with the copy marker in the step segment, so stripping it back and
 * checking THAT is both permissive enough for a real copy and tight enough to
 * refuse an invented key. See lib/flows/customSteps.ts. */
function isWritableKey(key: string): boolean {
  if (VALID_KEYS.has(key)) return true;
  // A `*.blocks` key holds a message BODY as JSON, not copy, so it is not in
  // the catalog and flattenKeys() will never list it.
  if (key.endsWith(".blocks")) return true;
  if (!key.includes(COPY_MARKER)) return false;
  const parts = key.split(".");
  return VALID_KEYS.has(parts.map((p) => (p.includes(COPY_MARKER) ? sourceOf(p) : p)).join("."));
}

function bad(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function GET(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  const locale = new URL(request.url).searchParams.get("locale");
  if (!isLocale(locale)) return bad("A supported locale is required.");

  const admin = createServiceClient();
  const { data, error } = await admin
    .from("message_override_drafts")
    .select("key,value,updated_at,updated_by")
    .eq("locale", locale);
  if (error) return bad(`Could not load drafts: ${error.message}`, 500);

  return Response.json({
    locale,
    drafts: Object.fromEntries((data ?? []).map((r) => [r.key as string, r.value as string])),
    count: data?.length ?? 0,
  });
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Invalid JSON body.");
  }
  const { action, locale, key, value } = (body ?? {}) as {
    action?: unknown; locale?: unknown; key?: unknown; value?: unknown;
  };
  if (!isLocale(locale)) return bad("A supported locale is required.");
  const admin = createServiceClient();

  if (action === "save") {
    // A `*.blocks` key holds a message BODY as JSON, not copy, so it is not in
    // the catalog and flattenKeys() will never list it.
    const isBlocks = typeof key === "string" && key.endsWith(".blocks");
    if (typeof key !== "string" || !isWritableKey(key)) {
      return bad(`Unknown message key: ${String(key)}`);
    }
    if (typeof value !== "string") return bad("value must be a string.");

    // An empty value means "stop overriding this key", which is a DELETE of the
    // draft rather than a draft that blanks the string — a blank subject line
    // reaching a florist is not something an empty text box should be able to do.
    if (value.trim() === "") {
      const { error } = await admin.from("message_override_drafts").delete().eq("locale", locale).eq("key", key);
      if (error) return bad(`Could not clear the draft: ${error.message}`, 500);
      return Response.json({ ok: true, cleared: true });
    }

    // Sanitise on the way IN. Also applied at render, on purpose: this alone
    // would trust every row already in the table, including anything written
    // before a rule changed. See lib/messages/richText.ts.
    //
    // A blocks payload cannot go through the sanitiser whole: it escapes every
    // `"` outside an allowed tag, which turns the JSON into something
    // JSON.parse rejects, and the render pipeline would then silently fall
    // back to the fixed body. So parse it, sanitise each block's CONTENT
    // (which is the part that is actually staff-authored HTML), and
    // re-serialise. An unparseable payload is rejected here rather than stored
    // as a draft that can never render.
    let clean: string;
    if (isBlocks) {
      const blocks = parseBlocks(value);
      if (!blocks) return bad("That body is not a valid set of segments.");
      clean = serializeBlocks(
        blocks.map((b) =>
          b.type === "steps"
            ? { ...b, items: (b.items ?? []).map(sanitizeRichText) }
            : { ...b, html: sanitizeRichText(b.html ?? "") }
        )
      );
    } else {
      clean = sanitizeRichText(value);
    }

    const { error } = await admin.from("message_override_drafts").upsert(
      // A person wrote this value, so Polyglot's ai_context no longer describes it.
      { locale, key, value: clean, updated_at: new Date().toISOString(), updated_by: gate.email, ai_context: null },
      { onConflict: "locale,key" }
    );
    if (error) return bad(`Could not save the draft: ${error.message}`, 500);
    return Response.json({ ok: true });
  }

  if (action === "publish") {
    // `keys` narrows the publish to ONE message. /messages publishes the whole
    // locale (its counter says how many, and its user is the person who made
    // them); /flows must not — pressing Save on a subject line there would
    // otherwise also push live whatever anyone else had left half-written in
    // this language. That happened on staging on 2026-09-03: a one-key Save
    // reported "published 7".
    const { keys } = body as { keys?: unknown };
    const scoped = Array.isArray(keys)
      ? keys.filter((k): k is string => typeof k === "string" && isWritableKey(k))
      : null;
    if (Array.isArray(keys) && (!scoped || scoped.length === 0)) {
      return bad("No recognised keys to publish.");
    }

    let query = admin.from("message_override_drafts").select("key,value").eq("locale", locale as Locale);
    if (scoped) query = query.in("key", scoped);
    const { data: drafts, error: readErr } = await query;
    if (readErr) return bad(`Could not read drafts: ${readErr.message}`, 500);
    if (!drafts || drafts.length === 0) return Response.json({ ok: true, published: 0 });

    // Upsert first, delete second. If the delete fails the drafts simply
    // remain and republishing is a no-op — the failure mode is a redundant
    // draft, never a published change that silently vanishes.
    const { error: writeErr } = await admin.from("message_overrides").upsert(
      drafts.map((d) => ({
        locale,
        key: d.key as string,
        value: d.value as string,
        updated_at: new Date().toISOString(),
        updated_by: gate.email,
      })),
      { onConflict: "locale,key" }
    );
    if (writeErr) return bad(`Could not publish: ${writeErr.message}`, 500);

    let clear = admin.from("message_override_drafts").delete().eq("locale", locale);
    if (scoped) clear = clear.in("key", scoped);
    const { error: clearErr } = await clear;
    if (clearErr) {
      return Response.json(
        { ok: true, published: drafts.length, warning: "Published, but the drafts could not be cleared. Publishing again is harmless." },
        { status: 200 }
      );
    }
    return Response.json({ ok: true, published: drafts.length });
  }

  // "Undo" on /flows: put ONE message back the way it was, rather than the
  // whole locale. Deletes the unpublished drafts for these keys and, when
  // `published` is set, the live overrides too — which restores the built-in
  // wording, because a key with no override row IS the built-in string.
  //
  // Scoped to a key list on purpose: the locale-wide discard above would also
  // throw away a colleague's unrelated draft, and there is no way to tell from
  // this screen that you had.
  if (action === "revert") {
    const { keys, published } = body as { keys?: unknown; published?: unknown };
    if (!Array.isArray(keys) || keys.length === 0) return bad("keys must be a non-empty array.");
    const clean = keys.filter((k): k is string => typeof k === "string" && isWritableKey(k));
    if (clean.length === 0) return bad("No recognised keys to undo.");

    const { error: draftErr } = await admin
      .from("message_override_drafts")
      .delete()
      .eq("locale", locale)
      .in("key", clean);
    if (draftErr) return bad(`Could not undo: ${draftErr.message}`, 500);

    if (published === true) {
      const { error: liveErr } = await admin
        .from("message_overrides")
        .delete()
        .eq("locale", locale)
        .in("key", clean);
      if (liveErr) return bad(`Could not restore the original wording: ${liveErr.message}`, 500);
    }
    return Response.json({ ok: true, reverted: clean.length, published: published === true });
  }

  if (action === "discard") {
    const { error } = await admin.from("message_override_drafts").delete().eq("locale", locale);
    if (error) return bad(`Could not discard drafts: ${error.message}`, 500);
    return Response.json({ ok: true });
  }

  return bad(`Unknown action: ${String(action)}`);
}
