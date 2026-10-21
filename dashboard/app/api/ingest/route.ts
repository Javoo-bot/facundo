import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { isAllowed, getStaffRole } from "@/lib/allowlist";
import { createServerClient } from "@/lib/supabase";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { parseBatchCities } from "@/lib/ingestBatch";

// Ingest trigger mode. "queue" (set on the Cloudflare Workers deployment via
// wrangler.jsonc) enqueues a `queued` ingest_jobs row for the Mac-mini poller
// (ingest/poll_jobs.py) to claim and run — the Worker cannot spawn Python.
// Anything else (unset locally) keeps the original spawn-the-CLI behavior, so
// `npm run dev` on a box that HAS the Python CLI still runs ingest inline.
const INGEST_MODE = process.env.INGEST_MODE === "queue" ? "queue" : "spawn";

// Spawns a real OS process — must run on the Node runtime, never the Edge
// runtime.
export const runtime = "nodejs";
// This handler spawns a process and validates a session on every call; never
// let Next.js statically optimize or cache it.
export const dynamic = "force-dynamic";

const MAX_STRING_LEN = 100;
const MIN_RADIUS_KM = 0.5;
const MAX_RADIUS_KM = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
const MIN_KEYWORDS = 1;
const MAX_KEYWORDS = 10; // mirrors AddCityForm's chip cap
const MAX_KEYWORD_LEN = 60;
const MAX_LANGUAGE_LEN = 10; // room for BCP-47-ish codes like "pt-BR"

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface IngestRequestBody {
  country: string;
  city: string;
  radius: number;
  limit: number;
  // Null in queue mode when the caller lets the Mac-mini CLI derive localized
  // keywords itself (main.py derives when --keywords is omitted). Always
  // non-null in spawn mode.
  keywords: string[] | null;
  language: string | null;
  resetExisting: boolean;
}

/** Validates the request body against the CLI's flag contract (see
 * docs/superpowers/specs/2026-07-02-localized-search-enrichment-design.md).
 * Returns either the parsed, trimmed values or an error message — never
 * throws. */
function parseAndValidate(
  body: unknown,
  // In queue mode the caller may omit keywords entirely and let the Mac-mini
  // CLI derive them (main.py derives when --keywords is omitted). In spawn mode
  // keywords stay required, exactly as before.
  allowEmptyKeywords: boolean
): { ok: true; value: IngestRequestBody } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  const { country, city, radius, limit, keywords, language, resetExisting } = body as Record<
    string,
    unknown
  >;

  if (typeof country !== "string" || typeof city !== "string") {
    return { ok: false, message: "country and city must be strings." };
  }
  const trimmedCountry = country.trim();
  const trimmedCity = city.trim();
  if (!trimmedCountry || !trimmedCity) {
    return { ok: false, message: "country and city must not be empty." };
  }
  if (trimmedCountry.length > MAX_STRING_LEN || trimmedCity.length > MAX_STRING_LEN) {
    return { ok: false, message: `country and city must be at most ${MAX_STRING_LEN} characters.` };
  }

  const radiusNum = typeof radius === "number" ? radius : Number(radius);
  if (!Number.isFinite(radiusNum) || radiusNum < MIN_RADIUS_KM || radiusNum > MAX_RADIUS_KM) {
    return {
      ok: false,
      message: `radius must be a number between ${MIN_RADIUS_KM} and ${MAX_RADIUS_KM} (km).`,
    };
  }

  const limitNum = typeof limit === "number" ? limit : Number(limit);
  if (!Number.isInteger(limitNum) || limitNum < MIN_LIMIT || limitNum > MAX_LIMIT) {
    return { ok: false, message: `limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}.` };
  }

  // Queue mode: keywords omitted/null/[] means "derive on the Mac mini". Store
  // keywords AND language as null so the poller omits --keywords, and main.py
  // derives them (and picks the language) from --country.
  const keywordsOmitted =
    keywords === undefined ||
    keywords === null ||
    (Array.isArray(keywords) && keywords.length === 0);
  if (allowEmptyKeywords && keywordsOmitted) {
    if (resetExisting !== undefined && typeof resetExisting !== "boolean") {
      return { ok: false, message: "resetExisting must be a boolean." };
    }
    return {
      ok: true,
      value: {
        country: trimmedCountry,
        city: trimmedCity,
        radius: radiusNum,
        limit: limitNum,
        keywords: null,
        language: null,
        resetExisting: resetExisting === true,
      },
    };
  }

  if (!Array.isArray(keywords)) {
    return { ok: false, message: "keywords must be an array of strings." };
  }
  if (keywords.length < MIN_KEYWORDS || keywords.length > MAX_KEYWORDS) {
    return {
      ok: false,
      message: `keywords must contain between ${MIN_KEYWORDS} and ${MAX_KEYWORDS} entries.`,
    };
  }
  const trimmedKeywords: string[] = [];
  for (const keyword of keywords) {
    if (typeof keyword !== "string") {
      return { ok: false, message: "each keyword must be a string." };
    }
    const trimmedKeyword = keyword.trim();
    if (!trimmedKeyword) {
      return { ok: false, message: "keywords must not be empty strings." };
    }
    if (trimmedKeyword.length > MAX_KEYWORD_LEN) {
      return { ok: false, message: `each keyword must be at most ${MAX_KEYWORD_LEN} characters.` };
    }
    trimmedKeywords.push(trimmedKeyword);
  }

  if (typeof language !== "string") {
    return { ok: false, message: "language must be a string." };
  }
  const trimmedLanguage = language.trim();
  if (!trimmedLanguage) {
    return { ok: false, message: "language must not be empty." };
  }
  if (trimmedLanguage.length > MAX_LANGUAGE_LEN) {
    return { ok: false, message: `language must be at most ${MAX_LANGUAGE_LEN} characters.` };
  }

  if (resetExisting !== undefined && typeof resetExisting !== "boolean") {
    return { ok: false, message: "resetExisting must be a boolean." };
  }

  return {
    ok: true,
    value: {
      country: trimmedCountry,
      city: trimmedCity,
      radius: radiusNum,
      limit: limitNum,
      keywords: trimmedKeywords,
      language: trimmedLanguage,
      resetExisting: resetExisting === true,
    },
  };
}

export async function POST(request: Request): Promise<Response> {
  // AUTH GATE — only allow-listed, signed-in users may spend Apify/Claude
  // credits (or enqueue a job that will). Checked before anything else; no job
  // is enqueued and no process is spawned otherwise.
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return jsonError("Not signed in.", 401);
  }
  if (!(await isAllowed(user.email))) {
    return jsonError("This account is not authorized to run ingestion.", 403);
  }
  const role = await getStaffRole(user.email);
  if (!role || !["ops", "admin"].includes(role)) {
    return jsonError("Your role doesn't allow this.", 403);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  // BATCH PATH — { cities: [...] }. Keywords/language are always derived by
  // the pipeline per-country (queue mode enqueues null; spawn mode omits
  // --keywords and the CLI derives). The legacy single-city body (with
  // keywords/language, sent by the AddCity wizard) falls through unchanged.
  if (rawBody && typeof rawBody === "object" && Array.isArray((rawBody as { cities?: unknown }).cities)) {
    const batch = parseBatchCities(rawBody);
    if (!batch.ok) return jsonError(batch.message, 400);
    const { cities, radius, limit, resetExisting } = batch.value;

    const admin = createServiceClient();
    const enqueued: { country: string; city: string; jobId: string }[] = [];
    const skipped: { country: string; city: string; reason: string }[] = [];

    for (const { country, city } of cities) {
      // Per-city duplicate guard — a city already queued/running is skipped,
      // never fails the batch.
      const { data: pending } = await supabase
        .from("ingest_jobs")
        .select("id")
        .eq("country", country)
        .eq("city", city)
        .in("status", ["queued", "running"])
        .limit(1);
      if (pending && pending.length > 0) {
        skipped.push({ country, city, reason: "already running" });
        continue;
      }

      if (INGEST_MODE === "queue") {
        const jobId = randomUUID();
        const { error } = await admin.from("ingest_jobs").insert({
          id: jobId,
          country,
          city,
          radius_km: radius,
          limit_per_keyword: limit,
          keywords: null, // pipeline derives per-country
          language: null,
          reset_existing: resetExisting,
          status: "queued",
        });
        if (error) {
          skipped.push({ country, city, reason: `enqueue failed: ${error.message}` });
          continue;
        }
        enqueued.push({ country, city, jobId });
      } else {
        // Spawn mode (local dev only): run the CLI per city, deriving keywords.
        const jobId = randomUUID();
        const ingestCwd = path.resolve(process.cwd(), "..", "ingest");
        const args = [
          "run", "python", "main.py",
          "--job-id", jobId,
          "--country", country,
          "--city", city,
          "--radius", String(radius),
          "--limit", String(limit),
        ];
        if (resetExisting) args.push("--reset-existing");
        const child = spawn("uv", args, { cwd: ingestCwd, shell: false, detached: true, stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
        enqueued.push({ country, city, jobId });
      }
    }

    if (enqueued.length === 0) {
      // Report the REAL reasons. This used to hardcode "(already running)" for
      // every skip, but `skipped` also collects `enqueue failed: <db error>` —
      // so a failing INSERT was reported as a phantom running job, sending
      // whoever hit it hunting for a job that did not exist. Observed for real
      // when the `mode` column was missing: every insert errored and the UI
      // insisted all 60 cities were already running.
      const reasons = [...new Set(skipped.map((s) => s.reason))].join("; ");
      return jsonError(
        skipped.length > 0 ? `All cities were skipped. ${reasons}` : "Nothing to enqueue.",
        409
      );
    }
    return Response.json({ enqueued, skipped });
  }

  // In queue mode the caller may omit keywords and let the Mac-mini CLI derive
  // them; in spawn mode keywords stay required (the CLI is invoked directly).
  const parsed = parseAndValidate(rawBody, INGEST_MODE === "queue");
  if (!parsed.ok) {
    return jsonError(parsed.message, 400);
  }
  const { country, city, radius, limit, keywords, language, resetExisting } = parsed.value;

  // Duplicate-guard: reject if this exact (country, city) already has a
  // `running` job row. Best-effort — a race between two near-simultaneous
  // requests could still both pass this check and spawn two processes, but
  // that's an acceptable POC-scale gap (see the design spec's "Safety"
  // section, which allows either this check or a UI-level disable; this is
  // the one easy half of that, done server-side so it also covers the wizard
  // and both re-run entry points).
  // In queue mode a job sits in `queued` until the poller claims it, so a
  // pending-but-unclaimed run must also block a duplicate.
  const { data: pendingJobs } = await supabase
    .from("ingest_jobs")
    .select("id")
    .eq("country", country)
    .eq("city", city)
    .in("status", ["queued", "running"])
    .limit(1);
  if (pendingJobs && pendingJobs.length > 0) {
    return jsonError(`An ingest for ${city}, ${country} is already running.`, 409);
  }

  const jobId = randomUUID();

  // QUEUE MODE — the deployment can't spawn Python. Insert a `queued` row via
  // the service-role client (ingest_jobs has no RLS insert policy, same write
  // pattern as exclude/outreach/allowlist) for ingest/poll_jobs.py on the Mac
  // mini to claim and run. Fire-and-forget from the client's POV: the CLI owns
  // all further status writes, and the dashboard polls ingest_jobs.
  if (INGEST_MODE === "queue") {
    const admin = createServiceClient();
    const { error } = await admin.from("ingest_jobs").insert({
      id: jobId,
      country,
      city,
      radius_km: radius,
      limit_per_keyword: limit,
      keywords, // null => the Mac-mini CLI derives them
      language,
      reset_existing: resetExisting,
      status: "queued",
    });
    if (error) {
      return jsonError(`Failed to enqueue ingest job: ${error.message}`, 500);
    }
    return Response.json({ jobId });
  }

  // Spawn mode always has concrete keywords + language (parseAndValidate was
  // called with allowEmptyKeywords=false above and required them). This guard
  // both satisfies the type narrowing and fails safe if that ever changes.
  if (keywords === null || language === null) {
    return jsonError("keywords and language are required to run ingest.", 400);
  }

  // dashboard/ and ingest/ are sibling directories; process.cwd() for a
  // Next.js server process is the dashboard/ package root.
  const ingestCwd = path.resolve(process.cwd(), "..", "ingest");

  // Fire-and-forget: detached + unref'd so the child outlives this request
  // (and the client's tab/dialog/connection) entirely. The CLI itself now
  // owns writing progress to `ingest_jobs` (see ingest/jobs.py) — the
  // dashboard never streams or waits on it again. stdio is ignored (not
  // piped) because nothing here reads it; letting a detached child inherit
  // open pipes back to this process would keep the request from ever fully
  // releasing its file descriptors.
  //
  // Arg array + shell:false — no shell interpolation of user-supplied
  // country/city/keyword strings, so there's no command-injection surface
  // even though the values are already validated above. --keywords is
  // comma-joined into a single arg — safe because it's passed as one element
  // of the args array, never through a shell.
  try {
    const args = [
      "run",
      "python",
      "main.py",
      "--job-id",
      jobId,
      "--country",
      country,
      "--city",
      city,
      "--radius",
      String(radius),
      "--limit",
      String(limit),
      "--keywords",
      keywords.join(","),
      "--language",
      language,
    ];
    if (resetExisting) args.push("--reset-existing");

    const child = spawn("uv", args, { cwd: ingestCwd, shell: false, detached: true, stdio: "ignore" });
    // A detached child's spawn failure (e.g. `uv` missing) surfaces
    // asynchronously as an "error" event, not a thrown exception. With no
    // listener attached, Node treats an unhandled "error" event as an
    // uncaught exception and would crash this server process — log instead.
    child.on("error", (err) => {
      console.error(`[ingest] job ${jobId} failed to start:`, err);
    });
    child.unref();
  } catch (err) {
    return jsonError(
      `Failed to start ingest process: ${err instanceof Error ? err.message : String(err)}`,
      500
    );
  }

  return Response.json({ jobId });
}
