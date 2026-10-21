import { randomUUID } from "node:crypto";
import { isAllowed, getStaffRole } from "@/lib/allowlist";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { buildDraftPrompt, resolveTargetLanguage, type DraftFacts } from "@/lib/draftEmail";
import { buildRecruitingEmail } from "@/lib/recruitingContent";
import { personaliseRecruitingEmail, DEFAULT_RECRUITING_MODEL } from "@/lib/recruitingPersonalise";
import { needsNewJoinToken, joinTokenExpiry, buildJoinUrl } from "@/lib/floristJoin";
import { resolveFloristLocale, type Locale } from "@/lib/i18n";
import { loadOverrides } from "@/lib/messageOverrides";
import { FLORIST_BASE } from "@/lib/emailLinks";
import { agentSpec } from "@/lib/agents/registry.generated";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IDS = 25;
const CONCURRENCY = 5;

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface DraftResult {
  floristId: string;
  ok: boolean;
  draft?: string;
  error?: string;
}

interface FloristRow {
  id: string;
  name: string;
  rating: number | null;
  review_count: number | null;
  owner_name: string | null;
  shop_highlight: string | null;
  city_id: string;
  locale: string | null;
  join_token: string | null;
  join_token_expires_at: string | null;
  joined_at: string | null;
}

export async function POST(request: Request): Promise<Response> {
  // AUTH GATE — session + allow-list, before any service-role work or LLM spend.
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError("Not signed in.", 401);
  if (!(await isAllowed(user.email))) return jsonError("This account is not authorized.", 403);
  const role = await getStaffRole(user.email);
  if (!role || !["ops", "admin"].includes(role)) return jsonError("Your role doesn't allow this.", 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
  const floristIds = (body as { floristIds?: unknown })?.floristIds;
  if (!Array.isArray(floristIds) || floristIds.length === 0 || floristIds.length > MAX_IDS) {
    return jsonError(`floristIds must be an array of 1..${MAX_IDS} ids.`, 400);
  }
  const ids = floristIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (ids.length === 0) return jsonError("floristIds must contain non-empty strings.", 400);

  // Personalisation runs through OpenRouter (lib/recruitingPersonalise.ts),
  // the same integration the photo-verify shadow legs use. Not fatal when
  // unset: every florist then gets the deterministic catalog render, which is
  // a complete and correct email. Failing the whole run would be worse.
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_RECRUITING_MODEL || DEFAULT_RECRUITING_MODEL;

  const admin = createServiceClient();

  // Fetch the florists we're drafting for.
  const { data: florists, error: fErr } = await admin
    .from("florists")
    .select("id, name, rating, review_count, owner_name, shop_highlight, city_id, locale, join_token, join_token_expires_at, joined_at")
    .in("id", ids);
  if (fErr) return jsonError(`Failed to load florists: ${fErr.message}`, 500);
  if (!florists || florists.length === 0) return jsonError("No matching florists.", 404);
  const rows = florists as FloristRow[];

  // Resolve each florist's city (name + country) and the country's Maps language.
  const cityIds = [...new Set(rows.map((f) => f.city_id))];
  const { data: cities } = await admin
    .from("cities")
    .select("id, city, country")
    .in("id", cityIds);
  const cityById = new Map((cities ?? []).map((c) => [c.id as string, c as { id: string; city: string; country: string }]));

  const countries = [...new Set((cities ?? []).map((c) => c.country as string))];
  const { data: kw } = await admin
    .from("country_keywords")
    .select("country, language")
    .in("country", countries);
  const langByCountry = new Map((kw ?? []).map((k) => [k.country as string, k.language as string | null]));


  // Message-override cache, keyed by locale — loaded lazily and reused across
  // florists in the batch so a 25-florist draft run does at most one
  // message_overrides read per distinct locale, not one per florist.
  const overridesCache = new Map<Locale, Record<string, string>>();
  async function getOverrides(locale: Locale): Promise<Record<string, string>> {
    const cached = overridesCache.get(locale);
    if (cached) return cached;
    const loaded = await loadOverrides(admin, locale);
    overridesCache.set(locale, loaded);
    return loaded;
  }

  async function draftOne(f: FloristRow): Promise<DraftResult> {
    const city = cityById.get(f.city_id);
    if (!city) return { floristId: f.id, ok: false, error: "City not found for florist." };
    // content_language is not persisted; resolve from the region only.
    const targetLanguage = resolveTargetLanguage(null, langByCountry.get(city.country) ?? null);
    const facts: DraftFacts = {
      name: f.name,
      rating: f.rating,
      review_count: f.review_count,
      owner_name: f.owner_name,
      shop_highlight: f.shop_highlight,
    };
    // The join link is minted BEFORE the body is built (it used to be appended
    // afterwards): the template decides whether to render a CTA line at all,
    // rather than ever printing a dead button.
    let joinUrl: string | null = null;
    if (!f.joined_at) {
      if (needsNewJoinToken(f, new Date())) {
        const newToken = randomUUID();
        const newExpiry = joinTokenExpiry(new Date());
        const { error: tokenErr } = await admin
          .from("florists")
          .update({ join_token: newToken, join_token_expires_at: newExpiry })
          .eq("id", f.id);
        if (!tokenErr) joinUrl = buildJoinUrl(FLORIST_BASE, newToken);
      } else if (f.join_token) {
        joinUrl = buildJoinUrl(FLORIST_BASE, f.join_token);
      }
    }

    const locale = resolveFloristLocale({ locale: f.locale });
    const overrides = await getOverrides(locale);
    // "Excellent reviews" is only claimed when we've actually seen some.
    // Otherwise the template opens neutrally rather than flattering a shop we
    // know nothing about.
    const hasReviews = f.rating != null && f.review_count != null && f.review_count > 0;
    // Public Q&A, in the florist's own language — the answers a cold shop
    // wants before replying (app/help/page.tsx).
    const canonical = buildRecruitingEmail(locale, overrides, {
      city: city.city,
      hasReviews,
      joinUrl,
      helpUrl: `${FLORIST_BASE}/help?locale=${locale}`,
    });
    // The deterministic render is BOTH the model's brief and the fallback: a
    // model outage yields a correct, on-message email rather than nothing.
    // Same "Subject: ...\n\n<body>" shape either way, so the outreach panel's
    // parser (lib/outreach.ts::parseDraft) and the reviewer's edit-before-send
    // flow don't care which path produced it.
    let combinedText = `Subject: ${canonical.subject}\n\n${canonical.body}`;

    // Personalisation is the whole point of keeping a model here: the florist's
    // own language, the owner's name, and an opening built from what we
    // researched about THIS shop. The offer and terms come from the catalog and
    // must survive. A null result (no key, timeout, non-200, or a reply that
    // lost the "Subject:" contract) leaves the deterministic render in place.
    // What Quill was shown, stored next to the draft it wrote. Null when no
    // model ran and the draft is the plain catalog render.
    let context: Record<string, unknown> | null = null;
    if (apiKey) {
      const prompt = buildDraftPrompt(facts, city.city, targetLanguage, canonical);
      const personalised = await personaliseRecruitingEmail({
        prompt,
        apiKey,
        model,
        trace: { agent: "quill", sessionId: f.id, metadata: { language: targetLanguage, locale } },
      });
      if (personalised) combinedText = personalised;
      context = { agent: "quill", prompt, model, personalised: personalised !== null, rulesHash: agentSpec("quill").rulesHash };
    }

    try {
      const { error: uErr } = await admin
        .from("florists")
        .update({ drafted_email: combinedText, drafted_email_context: context })
        .eq("id", f.id);
      if (uErr) return { floristId: f.id, ok: false, error: `Save failed: ${uErr.message}` };
      return { floristId: f.id, ok: true, draft: combinedText };
    } catch (e) {
      return { floristId: f.id, ok: false, error: e instanceof Error ? e.message : "Draft failed." };
    }
  }

  // Bounded concurrency — at most CONCURRENCY drafts in flight.
  const results: DraftResult[] = [];
  const queue = [...rows];
  async function worker() {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      results.push(await draftOne(f));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  return Response.json({ results });
}
