"use client";

import { useEffect, useRef, useState } from "react";

const DEFAULT_RADIUS_KM = 10;
const DEFAULT_LIMIT = 40;
// Mirrors app/api/ingest/route.ts's MAX_KEYWORDS / MAX_KEYWORD_LEN validation.
const MAX_KEYWORDS = 10;
const MAX_KEYWORD_LEN = 60;
// Fallback used when the user never fetched (or typed) a language — a
// reasonable default for a POC where most testing happens in English-
// speaking markets; the keyword-fetch flow overrides it whenever it runs.
const DEFAULT_LANGUAGE_FALLBACK = "en";

// Queue mode (the Cloudflare deployment): ingest runs on the Mac-mini poller,
// which derives localized keywords itself. So the keyword step becomes optional
// — we don't call /api/keywords (it 503s there) and allow submitting with none.
const INGEST_QUEUE_MODE = process.env.NEXT_PUBLIC_INGEST_MODE === "queue";

type WizardStep = 1 | 2 | 3;

const STEPS: { n: WizardStep; label: string }[] = [
  { n: 1, label: "Location" },
  { n: 2, label: "Scope" },
  { n: 3, label: "Keywords" },
];

const inputClasses =
  "mt-1 w-full rounded-md border border-line-strong px-3 py-1.5 text-sm shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-[var(--accent)] disabled:bg-surface-2 disabled:text-ink-faint";
const labelClasses = "block text-sm font-medium text-ink-soft";
const primaryButtonClasses =
  "rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-ink active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-line-strong disabled:active:scale-100";
const secondaryButtonClasses =
  "rounded-md border border-line-strong bg-surface px-4 py-2 text-sm font-medium text-ink-soft hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40";

/** Small step indicator — "1 Location · 2 Scope · 3 Keywords" with the
 * current step emphasized. Purely presentational; the wizard doesn't support
 * jumping to a step by clicking it (steps gate on validity, so a click-to-
 * jump affordance would need its own validation story — out of scope for a
 * POC stepper). */
function StepIndicator({ step }: { step: WizardStep }) {
  return (
    <ol aria-label="Add city steps" className="mb-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      {STEPS.map((s, i) => {
        const isActive = s.n === step;
        const isDone = s.n < step;
        return (
          <li key={s.n} className="flex items-center gap-1.5">
            <span
              aria-current={isActive ? "step" : undefined}
              className={`flex items-center gap-1.5 font-medium ${
                isActive ? "text-accent-ink" : isDone ? "text-ink-soft" : "text-ink-faint"
              }`}
            >
              <span
                aria-hidden="true"
                className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold ${
                  isActive ? "bg-accent text-white" : isDone ? "text-accent-ink" : "bg-surface-2 text-ink-faint"
                }`}
                style={
                  isDone && !isActive
                    ? { background: "color-mix(in srgb, var(--accent) 15%, transparent)" }
                    : undefined
                }
              >
                {s.n}
              </span>
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span aria-hidden="true" className="text-ink-faint">
                ·
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Field content for the "add a city" flow, paginated into a 3-step wizard
 * (Location -> Scope -> Keywords). Hooks/validation/ingest logic are
 * unchanged from the original single-page version — this only changes how
 * the fields are grouped and revealed. AddCityDialog still owns the
 * open/close affordance, focus trap, and success sub-state.
 */
export default function AddCityForm({
  onIngestSuccess,
  onRunningChange,
}: {
  /** Called once POST /api/ingest accepts the job (fire-and-forget — the
   * ingest itself now runs in the background; see the jobs panel for
   * progress). Country/city are echoed back from the form's own state,
   * which is what was sent to the route. */
  onIngestSuccess: (country: string, city: string) => void;
  /** Lets the dialog shell know whether it's safe to close (backdrop click /
   * Escape) — disabled only for the brief moment while the POST is in
   * flight, to avoid a double-submit. */
  onRunningChange?: (running: boolean) => void;
}) {
  // Wizard state lives in this component's local state, which is exactly
  // what resets it "when the dialog reopens": AddCityDialog only ever
  // renders AddCityForm while mounted, and PipelineHome unmounts
  // AddCityDialog entirely on close ({addCityOpen && <AddCityDialog />}), so
  // every open is a fresh mount starting at step 1.
  const [step, setStep] = useState<WizardStep>(1);

  const [country, setCountry] = useState("");
  const [city, setCity] = useState("");
  const [radius, setRadius] = useState(DEFAULT_RADIUS_KM);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [formError, setFormError] = useState<string | null>(null);

  const [keywords, setKeywords] = useState<string[]>([]);
  const [language, setLanguage] = useState<string | null>(null);
  const [lastFetchedCountry, setLastFetchedCountry] = useState<string | null>(null);
  const [keywordsLoading, setKeywordsLoading] = useState(false);
  const [keywordsError, setKeywordsError] = useState<string | null>(null);
  const [newKeyword, setNewKeyword] = useState("");

  // Only true for the brief window while POST /api/ingest is in flight — the
  // ingest itself now runs detached in the background, so there's nothing to
  // stream or cancel here anymore (see the jobs panel for progress).
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const countryInputRef = useRef<HTMLInputElement | null>(null);
  const radiusInputRef = useRef<HTMLInputElement | null>(null);
  const newKeywordInputRef = useRef<HTMLInputElement | null>(null);

  // Focus the first field of whichever step is active — covers both the
  // initial mount (step 1) and every Back/Next transition.
  useEffect(() => {
    if (step === 1) countryInputRef.current?.focus();
    else if (step === 2) radiusInputRef.current?.focus();
    else if (step === 3) newKeywordInputRef.current?.focus();
  }, [step]);

  useEffect(() => {
    onRunningChange?.(isSubmitting);
  }, [isSubmitting, onRunningChange]);

  const fetchKeywords = async () => {
    // In queue mode keyword derivation happens on the Mac mini and /api/keywords
    // 503s — never prefetch. The keyword step is optional there.
    if (INGEST_QUEUE_MODE) return;
    const trimmedCountry = country.trim();
    if (!trimmedCountry || trimmedCountry === lastFetchedCountry || keywordsLoading) return;

    setKeywordsLoading(true);
    setKeywordsError(null);
    try {
      const res = await fetch("/api/keywords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country: trimmedCountry }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let message = text;
        try {
          message = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
          // plain-text or empty body — use as-is
        }
        setKeywordsError(message || `Keyword lookup failed (${res.status}).`);
        return;
      }

      const data = (await res.json()) as { keywords: string[]; language: string };
      setKeywords(data.keywords.slice(0, MAX_KEYWORDS));
      setLanguage(data.language);
      setLastFetchedCountry(trimmedCountry);
    } catch (err) {
      setKeywordsError(err instanceof Error ? err.message : "Keyword lookup failed.");
    } finally {
      setKeywordsLoading(false);
    }
  };

  const addKeyword = () => {
    const trimmed = newKeyword.trim();
    if (!trimmed || keywords.length >= MAX_KEYWORDS || keywords.includes(trimmed)) {
      setNewKeyword("");
      return;
    }
    setKeywords((prev) => [...prev, trimmed]);
    setNewKeyword("");
  };

  const removeKeyword = (term: string) => {
    setKeywords((prev) => prev.filter((k) => k !== term));
  };

  const goToStep2 = () => {
    if (!country.trim() || !city.trim()) return;
    setFormError(null);
    // Kick off the keyword fetch when leaving step 1 as a safety net — the
    // onBlur handler below already covers the common case (tabbing/clicking
    // out of Country), but this guarantees it fires even if focus moved
    // straight from Country to the Next button. fetchKeywords no-ops if
    // this country was already fetched or a fetch is in flight.
    fetchKeywords();
    setStep(2);
  };

  const runIngest = async () => {
    if (isSubmitting) return;
    const trimmedCountry = country.trim();
    const trimmedCity = city.trim();
    // Spawn mode requires at least one keyword (the CLI is invoked with them
    // directly). Queue mode lets the Mac-mini CLI derive them, so an empty
    // keyword list is fine — enqueue null and let it derive.
    if (!INGEST_QUEUE_MODE && keywords.length === 0) {
      setFormError("At least one keyword is required — fetch keywords or add one manually.");
      return;
    }
    setFormError(null);
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      // In queue mode with no manually-added keywords, send null so the CLI
      // derives them. If the user did add keywords (either mode), send them
      // with a concrete language so /api/ingest's strict validation passes.
      const submitKeywords = INGEST_QUEUE_MODE && keywords.length === 0 ? null : keywords;
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          country: trimmedCountry,
          city: trimmedCity,
          radius,
          limit,
          keywords: submitKeywords,
          language: submitKeywords === null ? null : language ?? DEFAULT_LANGUAGE_FALLBACK,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let message = text;
        try {
          message = (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
          // plain-text or empty body — use as-is
        }
        setSubmitError(message || `Request failed (${res.status}).`);
        return;
      }

      // { jobId } comes back too, but nothing here needs it — the jobs
      // panel picks the new job up on its next poll.
      onIngestSuccess(trimmedCountry, trimmedCity);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to start ingest.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <StepIndicator step={step} />

      {step === 1 && (
        <div className="space-y-4">
          <label className={labelClasses}>
            Country
            <input
              ref={countryInputRef}
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              onBlur={fetchKeywords}
              disabled={isSubmitting}
              maxLength={100}
              placeholder="US"
              className={inputClasses}
            />
          </label>

          <label className={labelClasses}>
            City
            <input
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              disabled={isSubmitting}
              maxLength={100}
              placeholder="Boston"
              className={inputClasses}
            />
          </label>

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={goToStep2}
              disabled={!country.trim() || !city.trim()}
              className={primaryButtonClasses}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="flex gap-3">
            <label className={`flex-1 ${labelClasses}`}>
              Radius (km)
              <input
                ref={radiusInputRef}
                type="number"
                value={radius}
                onChange={(e) => setRadius(Number(e.target.value))}
                disabled={isSubmitting}
                min={0.5}
                max={50}
                step={0.5}
                className={inputClasses}
              />
            </label>
            <label className={`flex-1 ${labelClasses}`}>
              Limit (per keyword)
              <input
                type="number"
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                disabled={isSubmitting}
                min={1}
                max={200}
                step={1}
                className={inputClasses}
              />
              <span className="mt-1 block text-[11px] text-ink-faint">
                ≈ keywords × limit total results
              </span>
            </label>
          </div>

          <div className="flex justify-between gap-2 pt-1">
            <button type="button" onClick={() => setStep(1)} className={secondaryButtonClasses}>
              Back
            </button>
            <button type="button" onClick={() => setStep(3)} className={primaryButtonClasses}>
              Next
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between">
              <span className={labelClasses}>Keywords</span>
              {keywordsLoading && <span className="text-xs text-ink-faint">Fetching…</span>}
            </div>
            {language && (
              <span className="mt-1 inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-soft">
                Language: {language}
              </span>
            )}
            {keywordsError && <p className="mt-1 text-xs text-crit">{keywordsError}</p>}
            {INGEST_QUEUE_MODE && (
              <p className="mt-1 text-xs text-ink-soft">
                Optional — localized keywords are derived automatically on the ingest host.
                Add your own below only to override them.
              </p>
            )}

            {keywords.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {keywords.map((kw) => (
                  <span
                    key={kw}
                    className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-accent-ink ring-1 ring-inset ring-[var(--accent)]"
                    style={{ background: "color-mix(in srgb, var(--accent) 10%, transparent)" }}
                  >
                    {kw}
                    <button
                      type="button"
                      onClick={() => removeKeyword(kw)}
                      disabled={isSubmitting}
                      aria-label={`Remove keyword ${kw}`}
                      className="text-accent hover:text-accent-ink disabled:opacity-40"
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="mt-2 flex gap-1.5">
              <input
                ref={newKeywordInputRef}
                type="text"
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addKeyword();
                  }
                }}
                disabled={isSubmitting || keywords.length >= MAX_KEYWORDS}
                maxLength={MAX_KEYWORD_LEN}
                placeholder={keywords.length >= MAX_KEYWORDS ? `Max ${MAX_KEYWORDS} keywords` : "Add a keyword"}
                className="min-w-0 flex-1 rounded-md border border-line-strong px-2.5 py-1 text-sm shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-[var(--accent)] disabled:bg-surface-2"
              />
              <button
                type="button"
                onClick={addKeyword}
                disabled={isSubmitting || !newKeyword.trim() || keywords.length >= MAX_KEYWORDS}
                className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-ink-soft hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Add
              </button>
            </div>
          </div>

          {formError && <p className="text-xs text-crit">{formError}</p>}
          {submitError && (
            <p role="alert" className="text-xs text-crit">
              {submitError}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            {!isSubmitting && (
              <button type="button" onClick={() => setStep(2)} className={secondaryButtonClasses}>
                Back
              </button>
            )}
            <button
              type="button"
              onClick={runIngest}
              disabled={isSubmitting}
              className={`flex-1 ${primaryButtonClasses}`}
            >
              {isSubmitting ? "Starting…" : "Ingest"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
