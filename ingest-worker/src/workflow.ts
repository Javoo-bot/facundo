// CityIngestWorkflow — durable, per-city, step-checkpointed ingest. One
// instance per city. Mirrors the 8-step orchestration of ingest/main.py.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { chunk, isInstanceAlreadyExistsError, isPlatformInternalError } from "./batching";
import { llmClient, type LlmClient } from "./openrouter";
import {
  createServiceClient,
  getOrCreateCity,
  getCityCenter,
  softDeleteCityFlorists,
  getExcludedPlaceIds,
  getPlaceIdsWithAdvancedLifecycle,
  upsertFlorists,
  fillNullLocales,
  buildBareRow,
  buildRow,
  appendOrderEvent,
  findCityIdByName,
  selectRepairTargets,
  applyRepairPatch,
  sweepSharedEmails,
  loadNetworkRegistry,
} from "./db";
import { buildRepairPatch, needsRepair, patchAddsEmail } from "./repair";
import { rematchOrdersAwaitingArea } from "./autoIngest";
import { matchAndWriteCandidates } from "./lateMatch";
import { geocodeCityCenter, haversineKm } from "./geocode";
import { getKeywordsForCountry } from "./keywords";
import { startApifyRun, collectApifyResults } from "./apify";
import { countryToRegion } from "./phones";
import { regionToLocale } from "./locale";
import { enrichFlorist, FAILED_ENRICHMENT, ENRICH_FLORIST_TIMEOUT_MS, type RecordedUsage } from "./enrich";
import { isLlmOutage } from "./openrouter";
import { categoryMatchesFlorist, classifyRelevance, isRelevanceOutage, looksLikeRealBusiness } from "./relevance";
import { UsageTracker } from "./usage";
import { updateJobProgress, finishJob } from "./jobs";
import { MAX_CONCURRENT_ENRICHMENTS, ENRICH_BATCH_SIZE } from "./config";
import type {
  Env,
  CityWorkflowParams,
  ScrapedFlorist,
  EnrichmentResult,
  RepairTarget,
  EnrichBatchParams,
  EnrichBatchOutput,
} from "./types";

/** What one florist's repair step reports back: the LLM cost it incurred, and
 * whether it actually recovered an address (which decides both the log line and
 * whether the shared-address sweep is worth running). */
interface RepairOutcome {
  usages: RecordedUsage[];
  emailed: boolean;
  /** The row changed between the select and its turn in the pool, so it was
   * left alone rather than re-enriched against a stale read. */
  skipped: boolean;
}

/** Rebuild the ScrapedFlorist that enrichFlorist takes from a stored row. Every
 * field is already on `florists` except `maps_online_order`, which is a Maps
 * signal we never persisted; it only nudges the ecommerce classifier, so a
 * repair passes null and lets the crawl's own signals decide. */
function repairTargetToScraped(row: RepairTarget): ScrapedFlorist {
  return {
    place_id: row.place_id,
    name: row.name,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    rating: row.rating,
    review_count: row.review_count,
    phone_maps: row.phone_maps,
    website_url: row.website_url,
    maps_online_order: null,
    category_name: row.category_name,
    categories: row.categories,
    distance_km_from_center: row.distance_km_from_center,
  };
}

/** Run `items` through `fn` with at most `concurrency` in flight; results in
 * input order (like Promise.all, but bounded). */
async function runPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** Dispatch `batches` as sequential ENRICH_BATCH_WORKFLOW child instances —
 * one at a time, never concurrent siblings — and return each one's output in
 * order. See config.ts::ENRICH_BATCH_SIZE for why: a single continuous
 * Workflow instance accumulates memory across every `step.do()` it runs, so
 * bounding each child to one batch bounds peak memory regardless of how big
 * the city is. Stops dispatching (but still returns what already ran) the
 * moment a batch reports an LLM outage — the same circuit-breaker semantics
 * `run()`/`runRepair()` already had within a single instance, just now
 * spanning instances instead of pool workers.
 *
 * Polls each child via `.status()` inside a retrying `step.do()` — the
 * status call itself is idempotent and near-free, so using the step's own
 * retry/backoff as the poll loop needs no extra machinery. A child that
 * errors or is terminated fails this step (and, propagated, the parent job)
 * rather than being silently skipped: an uncaught throw here means something
 * broke outside the per-florist try/catch inside the child, which is exactly
 * the kind of failure that should surface loudly, same as any other
 * unexpected `run()` exception. */
// A child instance can end up "errored" for two very different reasons: our
// own code threw (a real bug — must surface loudly), or the Cloudflare
// Workflows platform itself hit an internal fault unrelated to anything this
// codebase controls (documented, long-standing: "WorkflowInternalError" /
// "Attempt failed due to internal workflows error" — see e.g.
// github.com/cloudflare/workers-sdk issues and the Cloudflare community
// forum; this repo has hit it since at least 2026-08-04, on ordinary cities,
// well before batching existed). Retrying the SAME batch with a fresh
// instance is the documented workaround-of-last-resort for the second case,
// and every recorded occurrence here has been on a different city/florist —
// there's no evidence any specific content triggers it, consistent with a
// platform fault rather than an app-level one.
const MAX_BATCH_ATTEMPTS = 3;

async function runEnrichBatches(
  env: Env,
  step: WorkflowStep,
  echo: (line: string) => Promise<string>,
  jobId: string,
  batches: EnrichBatchParams[]
): Promise<EnrichBatchOutput[]> {
  const outputs: EnrichBatchOutput[] = [];
  for (let i = 0; i < batches.length; i++) {
    const bp = batches[i];
    const size = (bp.florists ?? bp.targets ?? []).length;

    let output: EnrichBatchOutput | undefined;
    for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
      // A fresh instance id per attempt: a child instance that's reached
      // "errored" is terminal — re-creating the SAME id throws, same as any
      // other already-exists collision, so a retry needs a genuinely new one.
      const instanceId = `${jobId}-enrich-batch-${i}${attempt > 1 ? `-retry${attempt}` : ""}`;

      // Idempotent by necessity, not by choice: a Workflow step's callback can
      // be re-invoked more than once for the same logical run before its
      // result is durably checkpointed (the platform's own "at-least-once"
      // execution model — see the "Idempotency Violation" gotcha in the
      // Workflows docs). `.create()` isn't naturally idempotent (a second call
      // with the same id throws), which is exactly what broke Zadar/Kfar Saba/
      // Girona on 2026-09-03: the create step ran, the batch was dispatched,
      // and a re-invocation of this SAME step hit "instance.already_exists"
      // and failed the whole job. Treat that one error as success — the
      // instance already exists is the entire point of this step.
      await step.do(`enrich-batch-start:${i}:${attempt}`, async () => {
        try {
          await env.ENRICH_BATCH_WORKFLOW.create({ id: instanceId, params: bp });
        } catch (e) {
          if (!isInstanceAlreadyExistsError(e)) throw e;
        }
      });
      await echo(
        attempt === 1
          ? `      Batch ${i + 1}/${batches.length}: dispatched (${size} florist(s))...`
          : `      Batch ${i + 1}/${batches.length}: retrying with a fresh instance (attempt ${attempt}/${MAX_BATCH_ATTEMPTS})...`
      );

      try {
        output = await step.do(
          `enrich-batch-wait:${i}:${attempt}`,
          { retries: { limit: 120, delay: "10 seconds", backoff: "constant" } },
          async (): Promise<EnrichBatchOutput> => {
            const instance = await env.ENRICH_BATCH_WORKFLOW.get(instanceId);
            const status = await instance.status();
            if (status.status === "complete") return status.output as EnrichBatchOutput;
            if (status.status === "errored" || status.status === "terminated") {
              throw new NonRetryableError(
                `Batch ${i + 1}/${batches.length} (${instanceId}) ${status.status}: ${status.error?.message ?? "unknown error"}`
              );
            }
            throw new Error(`Batch ${i + 1}/${batches.length} still ${status.status}`); // triggers a retry
          }
        );
        break; // succeeded — stop retrying this batch
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (attempt < MAX_BATCH_ATTEMPTS && isPlatformInternalError(message)) {
          await echo(`      Batch ${i + 1}/${batches.length}: hit a Cloudflare platform error, not ours — retrying.`);
          continue;
        }
        throw e; // a real failure, or retries exhausted — surface it
      }
    }
    outputs.push(output!);
    await echo(`      Batch ${i + 1}/${batches.length}: done (${output!.count} florist(s)).`);
    if (output!.llmOutageHit) break;
  }
  return outputs;
}

/**
 * ENRICH_BATCH_WORKFLOW — CityIngestWorkflow's (and repair's) child. Runs the
 * exact per-florist logic `run()`/`runRepair()` used to run inline via
 * `runPool` directly, just scoped to one batch and one fresh isolate. See
 * config.ts::ENRICH_BATCH_SIZE and runEnrichBatches above for why this
 * exists (a 2026-09-03 "Worker exceeded memory limit" on a 352-florist city).
 */
export class EnrichBatchWorkflow extends WorkflowEntrypoint<Env, EnrichBatchParams> {
  async run(event: WorkflowEvent<EnrichBatchParams>, step: WorkflowStep): Promise<EnrichBatchOutput> {
    const p = event.payload;
    const sb = createServiceClient(this.env);
    const llm: LlmClient = llmClient(this.env);
    const llmOutage: { hit: boolean; detail: string } = { hit: false, detail: "" };

    if (p.mode === "repair") {
      const targets = p.targets ?? [];
      const networkRegistry = new Map(p.networkRegistryEntries ?? []);
      let repairIndex = 0;
      const outcomes = (await runPool(targets, MAX_CONCURRENT_ENRICHMENTS, (t) =>
        step.do(`repair:${t.place_id}`, async (): Promise<RepairOutcome> => {
          // Diagnostic only (not itself a step — a duplicate line on replay
          // is harmless): added 2026-09-04 after a batch died with "Worker
          // exceeded memory limit" and zero visibility into which florist it
          // was on. Pinpoints the last-attempted site on the next crash.
          repairIndex += 1;
          await updateJobProgress(
            sb,
            p.jobId,
            `      [batch] repairing ${repairIndex}/${targets.length}: ${t.name ?? t.place_id} (${t.website_url ?? "no url"})`
          );
          // Re-check in-process: the row may have been edited, excluded or
          // deleted since the parent's select.
          if (!needsRepair(t)) return { usages: [] as RecordedUsage[], emailed: false, skipped: true };
          if (llmOutage.hit) return { usages: [] as RecordedUsage[], emailed: false, skipped: true };

          const usages: RecordedUsage[] = [];
          let result = FAILED_ENRICHMENT;
          try {
            const timeout = new Promise<EnrichmentResult>((resolve) =>
              setTimeout(() => resolve(FAILED_ENRICHMENT), ENRICH_FLORIST_TIMEOUT_MS)
            );
            result = await Promise.race([
              enrichFlorist(repairTargetToScraped(t), llm, this.env, usages).then((r) => r.result),
              timeout,
            ]);
          } catch (e) {
            if (isLlmOutage(e)) {
              llmOutage.hit = true;
              llmOutage.detail = e instanceof Error ? e.message : String(e);
              return { usages, emailed: false, skipped: true };
            }
            result = FAILED_ENRICHMENT;
          }

          const patch = buildRepairPatch(t, result, p.phoneRegion, networkRegistry);
          const written = await applyRepairPatch(sb, t.id, patch);
          return { usages, emailed: written && patchAddsEmail(patch), skipped: false };
        })
      )) as RepairOutcome[];

      const usages = outcomes.flatMap((o) => o.usages);
      const emailsFound = outcomes.filter((o) => o.emailed).length;
      const skipped = outcomes.filter((o) => o.skipped).length;
      return {
        usages,
        llmOutageHit: llmOutage.hit,
        llmOutageDetail: llmOutage.detail,
        count: targets.length,
        emailsFound,
        skipped,
      };
    }

    // mode: "ingest"
    const florists = p.florists ?? [];
    let ingestIndex = 0;
    const usagesNested = await runPool(florists, MAX_CONCURRENT_ENRICHMENTS, (f) =>
      step.do(`enrich:${f.place_id}`, async () => {
        // Diagnostic only — see the matching comment in the repair branch above.
        ingestIndex += 1;
        await updateJobProgress(
          sb,
          p.jobId,
          `      [batch] enriching ${ingestIndex}/${florists.length}: ${f.name ?? f.place_id} (${f.website_url ?? "no url"})`
        );
        if (llmOutage.hit) return [];
        const usages: RecordedUsage[] = [];
        let result = FAILED_ENRICHMENT;
        try {
          const timeout = new Promise<EnrichmentResult>((resolve) =>
            setTimeout(() => resolve(FAILED_ENRICHMENT), ENRICH_FLORIST_TIMEOUT_MS)
          );
          result = await Promise.race([
            enrichFlorist(f, llm, this.env, usages).then((r) => r.result),
            timeout,
          ]);
        } catch (e) {
          if (isLlmOutage(e)) {
            llmOutage.hit = true;
            llmOutage.detail = e instanceof Error ? e.message : String(e);
            return usages;
          }
          result = FAILED_ENRICHMENT;
        }
        await upsertFlorists(sb, [buildRow({ ...f, ...result }, p.cityId, p.phoneRegion)]);
        return usages;
      })
    );
    const usages = usagesNested.flat();
    return { usages, llmOutageHit: llmOutage.hit, llmOutageDetail: llmOutage.detail, count: florists.length };
  }
}

export class CityIngestWorkflow extends WorkflowEntrypoint<Env, CityWorkflowParams> {
  async run(event: WorkflowEvent<CityWorkflowParams>, step: WorkflowStep): Promise<void> {
    const p = event.payload;
    const sb = createServiceClient(this.env);
    // Timeout + bounded retries now live in openrouter.ts::chat (plain fetch
    // has neither), so this is just the credential.
    const llm: LlmClient = llmClient(this.env);
    const tracker = new UsageTracker();
    let apifyCostUsd: number | null = null;

    // Deterministic step names are required for correct Workflow replay, so
    // log steps are numbered with a monotonic counter (never Math.random()).
    let logSeq = 0;
    const echo = (line: string) =>
      step.do(`log:${logSeq++}`, async () => {
        await updateJobProgress(sb, p.jobId, line);
        return line;
      });

    try {
      // REPAIR MODE — re-enrich rows already in the table, no Apify. Branches
      // here rather than in a second Workflow class so the whole surrounding
      // apparatus (cron claim, queue, progress log, cost accounting, /jobs) is
      // shared; the two modes have nothing in common after this point.
      if (p.mode === "repair") {
        await this.runRepair(p, sb, llm, tracker, step, echo);
        return;
      }

      // [1/8] geocode + get/create city. p.region/p.nearLat/p.nearLng
      // disambiguate same-named cities in different regions — see
      // supabase/migrations/2026-08-25-ingest-region-disambiguation.sql.
      const near = p.nearLat != null && p.nearLng != null ? { lat: p.nearLat, lng: p.nearLng } : null;
      const { cityId, center } = await step.do("geocode", async () => {
        const res = await getOrCreateCity(
          sb,
          p.country,
          p.city,
          p.radiusKm,
          () => geocodeCityCenter(p.country, p.city, p.region, near),
          p.region
        );
        const c = await getCityCenter(sb, res.cityId);
        return { cityId: res.cityId, center: c };
      });
      const phoneRegion = countryToRegion(p.country);
      await echo(`[1/8] Geocoded ${p.city}, ${p.country} (city_id=${cityId}).`);

      if (p.resetExisting) {
        await step.do("reset", () => softDeleteCityFlorists(sb, cityId));
      }

      // [2/8] resolve localized keywords (cache-first)
      const { keywords, language } = await step.do("keywords", () =>
        getKeywordsForCountry(sb, llm, p.country)
      );
      await echo(`[2/8] Keywords=${JSON.stringify(keywords)} language=${language}.`);

      // [3/8] scrape Apify. Start and collect are SEPARATE steps: the start
      // step (non-idempotent — bills a run) is memoized, so if the collect
      // step times out and retries, it re-polls the SAME run rather than
      // starting (and re-billing) a new one. The collect step gets an explicit
      // long timeout so a slow actor run doesn't trip the default 10-min step
      // timeout.
      const { runId, datasetId } = await step.do("scrape-start", () =>
        startApifyRun({
          token: this.env.APIFY_TOKEN,
          centerLat: center.lat,
          centerLng: center.lng,
          radiusKm: p.radiusKm,
          limit: p.limit,
          keywords,
          language,
        })
      );
      const scraped = await step.do(
        "scrape-collect",
        { retries: { limit: 2, delay: "10 seconds", backoff: "constant" }, timeout: "20 minutes" },
        () => collectApifyResults(this.env.APIFY_TOKEN, runId, datasetId, p.limit)
      );
      apifyCostUsd = scraped.apifyCostUsd;
      let florists: ScrapedFlorist[] = scraped.florists;
      await echo(`[3/8] Scraped ${florists.length} florist(s).`);

      // exclude permanently-denylisted place_ids
      const excludedArr = await step.do("exclude", async () => [
        ...(await getExcludedPlaceIds(sb, cityId)),
      ]);
      const excluded = new Set(excludedArr);
      if (excluded.size > 0) florists = florists.filter((f) => !excluded.has(f.place_id));

      // [4/8] relevance filter — drop Maps hits that matched a keyword but
      // aren't actually florists. A place whose place_id already has an
      // advanced lifecycle_stage (contacted+) is never re-judged: a Claude
      // false-negative on a re-scrape must not silently soft-delete a
      // florist that already has real outreach/order history.
      const vouchedArr = await step.do("vouched-lifecycle", async () => [
        ...(await getPlaceIdsWithAdvancedLifecycle(sb, cityId)),
      ]);
      const vouched = new Set(vouchedArr);
      const ruleKept: ScrapedFlorist[] = [];
      const ambiguous: ScrapedFlorist[] = [];
      // Dropped before ever reaching the LLM — see
      // relevance.ts::looksLikeRealBusiness for why an item with literally
      // no Maps category is treated as noise (a locality result, not a
      // business) rather than sent to the relevance judge, which had been
      // waving these through on nothing but a bare place name.
      const noCategoryData: ScrapedFlorist[] = [];
      for (const f of florists) {
        if (vouched.has(f.place_id)) {
          ruleKept.push(f);
        } else if (!looksLikeRealBusiness(f.category_name, f.categories)) {
          noCategoryData.push(f);
        } else if (categoryMatchesFlorist(f.category_name, f.categories, keywords)) {
          ruleKept.push(f);
        } else {
          ambiguous.push(f);
        }
      }
      const judged = await runPool(ambiguous, MAX_CONCURRENT_ENRICHMENTS, (f) =>
        step.do(`relevance:${f.place_id}`, async () => {
          const usages: RecordedUsage[] = [];
          try {
            const result = await classifyRelevance(llm, f, usages);
            if (typeof result.is_florist !== "boolean") {
              console.error(
                `[relevance] Claude returned a malformed relevance response for ${JSON.stringify(f.name)} (is_florist=${JSON.stringify(result.is_florist)}); keeping it (fail open).`
              );
              return { florist: f, keep: true as const, reason: null as string | null, usages };
            }
            if (result.is_florist) return { florist: f, keep: true as const, reason: null as string | null, usages };
            const reason = `"${f.name}" (${f.category_name || "no category"}) — Claude judged non-florist: ${result.reasoning} (confidence=${result.confidence.toFixed(2)})`;
            return { florist: f, keep: false as const, reason, usages };
          } catch (e) {
            console.error(
              `[relevance] relevance judging failed for ${JSON.stringify(f.name)} (${String(e)}); keeping it (fail open).`
            );
            return { florist: f, keep: true as const, reason: null as string | null, usages, failed: String(e) };
          }
        })
      );
      // Per-call failures are fail-open by design; a WHOLESALE failure is not
      // survivable, because "keep everything" is indistinguishable from "nothing
      // needed filtering" in the output. Fail the run so the job reports the
      // outage instead of persisting unfiltered noise as a success. See
      // relevance.ts::isRelevanceOutage for the incident this comes from.
      const relevanceFailures = judged.filter((j) => "failed" in j && j.failed).length;
      if (isRelevanceOutage(judged.length, relevanceFailures)) {
        const sample = judged.find((j) => "failed" in j && j.failed) as { failed?: string } | undefined;
        throw new Error(
          `Relevance filtering is down: ${relevanceFailures}/${judged.length} LLM call(s) failed, ` +
            `so every place would be kept unfiltered. Refusing to persist an unfiltered city. ` +
            `First error: ${sample?.failed ?? "(none captured)"}`
        );
      }

      florists = ruleKept.concat(judged.filter((j) => j.keep).map((j) => j.florist));
      const droppedByRelevance = judged.filter((j) => !j.keep);
      for (const j of judged) for (const u of j.usages) tracker.record(u.callType, u.model, u.usage);
      const totalDropped = droppedByRelevance.length + noCategoryData.length;
      await echo(`[4/8] Filtered ${totalDropped} place(s) that didn't look like florists (${florists.length} kept).`);
      if (noCategoryData.length > 0) {
        await echo(
          `      ${noCategoryData.length} of those had no Maps category at all (likely locality results, ` +
            `not businesses): ${noCategoryData.map((f) => f.name ?? f.place_id).join(", ")}`
        );
      }
      if (relevanceFailures > 0) {
        await echo(`      WARNING: ${relevanceFailures} relevance call(s) failed and were kept unjudged.`);
      }
      if (droppedByRelevance.length > 0) {
        const examples = droppedByRelevance.slice(0, 10).map((j) => j.reason).join("; ");
        const more = droppedByRelevance.length > 10 ? ` (+${droppedByRelevance.length - 10} more)` : "";
        await echo(`      e.g.: ${examples}${more}`);
      }

      // distance from center
      for (const f of florists) {
        f.distance_km_from_center =
          f.lat != null && f.lng != null ? haversineKm(center, { lat: f.lat, lng: f.lng }) : null;
      }

      // [6/8] persist bare rows (city queryable early)
      await step.do("bare-rows", () =>
        upsertFlorists(sb, florists.map((f) => buildBareRow(f, cityId, phoneRegion)))
      );
      await echo(`[6/8] Persisted ${florists.length} bare row(s).`);

      // Default each florist's UI/email language from the country (ES → 'es', …;
      // English/unmapped → left unset). Null-only fill, so a florist's own choice
      // is never overwritten (see fillNullLocales). No-op for English countries.
      const floristLocale = regionToLocale(phoneRegion);
      if (floristLocale) {
        const nLocaled = await step.do("fill-locales", () => fillNullLocales(sb, cityId, floristLocale));
        await echo(`      Set locale '${floristLocale}' on ${nLocaled} florist(s) with no language set.`);
      }

      // [7/8] enrich — dispatched as a sequence of child EnrichBatchWorkflow
      // instances (see runEnrichBatches above), one per ENRICH_BATCH_SIZE
      // florists, so peak memory is bounded per batch regardless of city
      // size. Per-florist isolation and the LLM-outage circuit breaker are
      // unchanged in spirit — see EnrichBatchWorkflow — just scoped to each
      // batch's own instance and threaded across batches by runEnrichBatches.
      const enrichBatches = chunk(florists, ENRICH_BATCH_SIZE).map(
        (batch): EnrichBatchParams => ({
          jobId: p.jobId,
          cityId,
          phoneRegion,
          mode: "ingest",
          florists: batch,
        })
      );
      await echo(
        `[7/8] Enriching ${florists.length} florist(s) across ${enrichBatches.length} batch(es) of up to ${ENRICH_BATCH_SIZE}...`
      );
      const batchOutputs = await runEnrichBatches(this.env, step, echo, p.jobId, enrichBatches);
      for (const out of batchOutputs) {
        for (const u of out.usages) tracker.record(u.callType, u.model, u.usage);
      }
      const outagedBatch = batchOutputs.find((o) => o.llmOutageHit);

      // Fail loudly. Silence is what made the 2026-08-06 outage expensive: the
      // run reported success, and the damage — a city of florists with null
      // emails and a note about billing — only surfaced when someone read the
      // notes weeks later. Everything up to here (Maps rows, geocoding, locales)
      // is already persisted and keeps its value; the un-enriched rows are left
      // for repair mode, which is what it is for.
      if (outagedBatch) {
        throw new Error(
          `LLM unavailable — enrichment stopped to avoid overwriting the rest of the city ` +
            `with empty results. Top up or fix the key, then re-run in repair mode. (${outagedBatch.llmOutageDetail})`
        );
      }

      // Orders that escalated because nothing was in range here now have
      // somebody to ask. Only orders still `escalated` and still tagged
      // `awaiting_ingest` for THIS area are touched — one CX has already placed
      // by hand has moved on and must not be rewound. Best-effort by design:
      // a successful ingest is still a successful ingest if this finds nothing.
      await step.do("rematch-awaiting-orders", async () => {
        const recovered = await rematchOrdersAwaitingArea(sb, { country: p.country, city: p.city }, async (orderId) => {
          const { data: o } = await sb
            .from("orders")
            .select("id, city_id, delivery_lat, delivery_lng, delivery_at, total, delivery_address")
            .eq("id", orderId)
            .single();
          if (!o) return 0;
          const found = await matchAndWriteCandidates(sb, {
            orderId,
            cityId: o.city_id as string | null,
            deliveryLat: o.delivery_lat as number | null,
            deliveryLng: o.delivery_lng as number | null,
            deliveryAt: o.delivery_at as string | null,
            orderTotal: (o.total as number | null) ?? 0,
            deliveryAddress: o.delivery_address,
          }, this.env);
          if (found > 0) {
            await appendOrderEvent(sb, orderId, "rematched_after_ingest", { country: p.country, city: p.city, candidates: found });
          }
          return found;
        });
        if (recovered.length) await echo(`Re-matched ${recovered.length} escalated order(s) waiting on this area.`);
        return recovered.length;
      });

      // finish
      await step.do("finish", () =>
        finishJob(sb, p.jobId, "succeeded", {
          usage: tracker,
          apifyCostUsd,
          floristCount: florists.length,
        })
      );
    } catch (e) {
      await step.do("finish-failed", () =>
        finishJob(sb, p.jobId, "failed", {
          error: e instanceof Error ? e.message : String(e),
          usage: tracker,
          apifyCostUsd,
        })
      );
      throw e;
    }
  }

  /**
   * Repair mode: re-run enrichment against florists ALREADY stored for this
   * city, with no Apify scrape.
   *
   * Why it exists: the crawl and the extraction fail independently. On
   * 2026-08-06 every page was fetched fine and every LLM leg returned "credit
   * balance is too low", leaving 1,732 live florists across 60 cities with a
   * website, no email, and the error sitting in their notes — each one an order
   * we can reach only by SMS. The pages are still on the web, so nothing here
   * needs to touch Apify or re-run the relevance filter.
   *
   * Errors propagate to run()'s catch, which files the failed job.
   */
  private async runRepair(
    p: CityWorkflowParams,
    sb: ReturnType<typeof createServiceClient>,
    llm: LlmClient,
    tracker: UsageTracker,
    step: WorkflowStep,
    echo: (line: string) => Promise<string>
  ): Promise<void> {
    // [1/4] resolve the city. Never creates one: a typo'd name must fail the
    // job rather than quietly "repair" a brand-new empty city.
    const cityId = await step.do("repair-city", () => findCityIdByName(sb, p.country, p.city));
    if (!cityId) {
      throw new Error(
        `No city row for ${p.city}, ${p.country} — repair only re-enriches florists already ingested. ` +
          `Run a normal ingest for this city first.`
      );
    }
    await echo(`[1/4] Repairing ${p.city}, ${p.country} (city_id=${cityId}) — no scrape.`);

    // [2/4] select targets: has a website, has no email, and its last
    // enrichment recorded a failure (see repair.ts::REPAIR_FAILURE_PATTERNS —
    // deliberately not keyed on any vendor's error text).
    // Workflows type a step's result as Serializable<T>, which widens every
    // field to possibly-undefined. The value round-trips through JSON unchanged,
    // so the cast restores what was actually stored.
    const targets = (await step.do("repair-select", () =>
      selectRepairTargets(sb, cityId)
    )) as RepairTarget[];
    // Says "failed OR never ran" because the two are genuinely different
    // states and the difference is what someone reading this log is trying to
    // work out. A row whose enrichment FAILED has notes saying so; a row
    // enrichment never reached has no notes at all (bare rows land at [6/8],
    // enrichment runs at [7/8], and a run that dies between them leaves 85
    // florists looking untouched — which is exactly how the first version of
    // this predicate came to report 2 targets in a city that had 87).
    await echo(
      `[2/4] ${targets.length} florist(s) have a website, no email, and an enrichment that failed or never ran.`
    );
    if (targets.length === 0) {
      await step.do("repair-finish-empty", () =>
        finishJob(sb, p.jobId, "succeeded", { usage: tracker, floristCount: 0 })
      );
      return;
    }

    // [3/4] enrich + patch. Same shape as the ingest path's step 7: dispatched
    // as a sequence of child EnrichBatchWorkflow instances (see
    // runEnrichBatches), bounding peak memory per batch regardless of how many
    // targets this city has.
    const phoneRegion = countryToRegion(p.country);
    // Domain → network id, so a shop whose "website" is its profile page on a
    // network/franchise/directory site is linked as we write. Loaded once per
    // run (12 rows today) and passed into every patch. Without it a recovered
    // head-office address looks like the shop's own — the dry run over six real
    // Toulouse rows produced contact@artisans-demo.fr and contact@reseau-demo.fr, and only
    // this flag catches the case where a single florist holds such an address.
    const networkRegistry = new Map(
      Object.entries(
        (await step.do("repair-network-registry", async () =>
          Object.fromEntries(await loadNetworkRegistry(sb))
        )) as Record<string, string>
      )
    );
    const repairBatches = chunk(targets, ENRICH_BATCH_SIZE).map(
      (batch): EnrichBatchParams => ({
        jobId: p.jobId,
        cityId,
        phoneRegion,
        mode: "repair",
        targets: batch,
        networkRegistryEntries: [...networkRegistry.entries()],
      })
    );
    await echo(
      `[3/4] Re-enriching ${targets.length} florist(s) across ${repairBatches.length} batch(es) of up to ${ENRICH_BATCH_SIZE}...`
    );
    // Same circuit breaker as the city run, and it matters more here: every row
    // in this pool is one a previous outage already spoiled. Grinding through
    // them against a dead key would replace one bad note with another and burn
    // the repair budget on nothing. See runEnrichBatches for how it now spans
    // batches instead of pool workers within one instance.
    const repairBatchOutputs = await runEnrichBatches(this.env, step, echo, p.jobId, repairBatches);
    for (const out of repairBatchOutputs) for (const u of out.usages) tracker.record(u.callType, u.model, u.usage);
    const emailsFound = repairBatchOutputs.reduce((sum, o) => sum + (o.emailsFound ?? 0), 0);
    const skipped = repairBatchOutputs.reduce((sum, o) => sum + (o.skipped ?? 0), 0);
    const outagedBatch = repairBatchOutputs.find((o) => o.llmOutageHit);
    await echo(
      `      Recovered ${emailsFound} email(s) from ${targets.length} florist(s)` +
        (skipped > 0 ? ` (${skipped} changed under us and were left alone).` : ".")
    );

    // [4/4] rescore shared addresses. Load-bearing, not housekeeping: an
    // address shared by several shops identifies none of them, and matching
    // relies on email_shared_count to stop sending one order's offers into a
    // single inbox (lib/lifecycle.ts records four offers to contact@reseau-demo.fr
    // from one Issy-les-Moulineaux order). Writing fresh addresses without
    // rescoring would recreate exactly that.
    //
    // Global and whole-table, so it's skipped entirely when this run found no
    // new address — otherwise 60 city jobs each page 6,800 rows for nothing.
    // Best-effort: the emails are already written and the sweep is idempotent,
    // so a failure here must not fail an otherwise-good repair.
    if (emailsFound > 0) {
      const changed = await step.do("repair-sweep-shared-emails", async () => {
        try {
          return await sweepSharedEmails(sb);
        } catch (e) {
          console.warn(`[repair] shared-email sweep failed: ${String(e)}`);
          return -1;
        }
      });
      await echo(
        changed < 0
          ? `[4/4] Shared-address rescoring failed — emails are written; re-run any repair to retry.`
          : `[4/4] Rescored shared addresses: ${changed} florist(s) changed.`
      );
    } else {
      await echo(`[4/4] No new addresses — shared-address rescoring skipped.`);
    }

    // A repair run that stopped early must not report success: the rows it
    // never reached are still spoiled, and "succeeded" is what would stop
    // anyone re-running it.
    if (outagedBatch) {
      throw new Error(
        `LLM unavailable — repair stopped after ${emailsFound} address(es); the remaining rows are ` +
          `untouched and still eligible. Top up or fix the key and re-run. (${outagedBatch.llmOutageDetail})`
      );
    }

    await step.do("repair-finish", () =>
      finishJob(sb, p.jobId, "succeeded", { usage: tracker, floristCount: targets.length })
    );
  }
}
