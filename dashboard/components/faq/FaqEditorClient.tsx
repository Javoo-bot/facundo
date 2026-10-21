"use client";

import SimpleToast from "@/components/SimpleToast";
import { missingVars, expectedVars } from "@/lib/i18n/varsManifest";
import { useCopyOverrides, type OverrideRow } from "@/lib/useCopyOverrides";
import { HELP_ARTICLES, HELP_CATEGORIES, HELP_CHROME_FIELDS, helpKey, type HelpArticle } from "@/lib/help/content";
import type { Locale, MessageTree } from "@/lib/i18n";

const LOCALE_LABEL: Record<Locale, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  de: "Deutsch",
  pt: "Português",
};

const CATEGORY_HINT: Record<string, string> = {
  app: "How the app itself works.",
  money: "The 70/30 split, the card, invoices.",
  orders: "Substitutions, bad addresses, handing an order back.",
  about: "Who we are, what it costs, how to reach a person.",
};

/** One editable string: a catalog key plus how to present it. */
interface Field {
  key: string;
  label: string;
  /** Single-line input rather than a textarea. */
  short?: boolean;
}

/** A save/revert unit — one article, or the page's own chrome. */
interface Group {
  id: string;
  title: string;
  hint?: string;
  fields: Field[];
}

function articleGroup(article: HelpArticle): Group {
  const callouts = article.media?.kind === "image" ? (article.media.callouts ?? []) : [];
  return {
    id: article.id,
    title: article.id,
    fields: [
      { key: helpKey(article.id, "q"), label: "Question", short: true },
      { key: helpKey(article.id, "body"), label: "Answer" },
      // Only present once an article declares a screenshot. The copy is
      // already written and translated, so these appear the moment the image
      // is switched on in lib/help/content.ts.
      ...callouts.map((c) => ({
        key: helpKey(article.id, `callout${c.n}`),
        label: `Screenshot label ${c.n}`,
        short: true,
      })),
    ],
  };
}

// Field list lives in lib/help/content.ts so content.test.mjs can prove this
// editor covers every string the page renders — see helpCopyKeys().
const CHROME: Group = {
  id: "__chrome",
  title: "Page heading and footer",
  hint: "The wrapper around the answers, on both /help and /florist/help.",
  fields: HELP_CHROME_FIELDS,
};

const CATEGORY_LABEL_GROUP: Group = {
  id: "__categories",
  title: "Category headings",
  fields: HELP_CATEGORIES.map((c) => ({ key: `ui.help.cat.${c}`, label: c, short: true })),
};

/**
 * Article-shaped editor for the florist Q&A.
 *
 * Same storage and same semantics as /email-templates — both run on
 * lib/useCopyOverrides.ts — but presented the way the page reads rather than as
 * a flat list of `ui.help.*` keys, and saved a whole answer at a time. Which
 * articles exist, and their order here, come straight from lib/help/content.ts,
 * so this page can never drift from what a florist actually sees.
 *
 * Structure (adding, removing or reordering an article) is deliberately NOT
 * editable: it is code, and changing it needs a deploy. Everything a reader
 * sees is editable and takes effect immediately.
 */
export default function FaqEditorClient({
  locales,
  catalogs,
  overrides: initialOverrides,
}: {
  locales: Locale[];
  catalogs: Record<Locale, MessageTree>;
  overrides: OverrideRow[];
}) {
  const {
    locale, selectLocale, effective, valueFor, isDirty, hasOverride, enReference,
    setDraft, saveKey, revertKey, busyKey, setBusyKey, toasts, push, dismiss,
  } = useCopyOverrides({ catalogs, initialOverrides });

  const sections = HELP_CATEGORIES.map((category) => ({
    category,
    groups: HELP_ARTICLES.filter((a) => a.category === category).map(articleGroup),
  }));

  const dirtyFields = (group: Group) => group.fields.filter((f) => isDirty(f.key));
  const overriddenFields = (group: Group) => group.fields.filter((f) => hasOverride(f.key));

  // Saved one key at a time because that's what the API takes. A partial
  // failure is reported as such rather than swallowed: the individual failure
  // toast already fired, so this only adds the summary.
  const saveGroup = async (group: Group) => {
    const dirty = dirtyFields(group);
    if (dirty.length === 0) return;
    setBusyKey(group.id);
    try {
      let saved = 0;
      for (const field of dirty) if (await saveKey(field.key)) saved++;
      if (saved === dirty.length) push("success", `Saved. Live on /help now.`);
      else push("error", `Saved ${saved} of ${dirty.length} fields — the rest are unchanged.`);
    } finally {
      setBusyKey(null);
    }
  };

  const revertGroup = async (group: Group) => {
    const overridden = overriddenFields(group);
    if (overridden.length === 0) return;
    setBusyKey(group.id);
    try {
      let done = 0;
      for (const field of overridden) if (await revertKey(field.key)) done++;
      if (done === overridden.length) push("success", "Reverted to the built-in copy.");
      else push("error", `Reverted ${done} of ${overridden.length} fields.`);
    } finally {
      setBusyKey(null);
    }
  };

  const renderGroup = (group: Group) => {
    const dirty = dirtyFields(group);
    const overridden = overriddenFields(group);
    const busy = busyKey === group.id;
    return (
      <div key={group.id} className="rounded-lg border p-4" style={{ borderColor: "var(--line)" }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <code className="text-xs text-ink-faint">{group.title}</code>
          {overridden.length > 0 && (
            <span
              className="rounded-full px-2 py-0.5 text-[11px] font-medium"
              style={{ background: "color-mix(in srgb, var(--accent) 15%, transparent)", color: "var(--accent)" }}
            >
              edited ({overridden.length})
            </span>
          )}
        </div>
        {group.hint && <p className="mt-1 text-xs text-ink-faint">{group.hint}</p>}

        <div className="mt-3 space-y-3">
          {group.fields.map((field) => {
            const value = valueFor(field.key);
            const { source } = effective(field.key);
            const missing = missingVars(field.key, value);
            const vars = expectedVars(field.key);
            return (
              <div key={field.key}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <label className="text-xs font-medium text-ink-soft" htmlFor={field.key}>
                    {field.label}
                  </label>
                  {source === "en-fallback" && (
                    <span className="text-[11px]" style={{ color: "var(--warn)" }}>
                      not translated — showing English
                    </span>
                  )}
                </div>
                {field.short ? (
                  <input
                    id={field.key}
                    value={value}
                    onChange={(e) => setDraft(field.key, e.target.value)}
                    className="mt-1 w-full rounded-md border border-line-strong px-3 py-1.5 text-sm"
                  />
                ) : (
                  <textarea
                    id={field.key}
                    value={value}
                    onChange={(e) => setDraft(field.key, e.target.value)}
                    rows={Math.min(8, Math.max(3, Math.ceil(value.length / 80)))}
                    className="mt-1 w-full rounded-md border border-line-strong px-3 py-1.5 text-sm"
                  />
                )}
                {vars.length > 0 && (
                  <p className="mt-1 text-xs text-ink-faint">
                    Must keep: {vars.map((v) => `{${v}}`).join(", ")}
                  </p>
                )}
                {missing.length > 0 && (
                  <p className="mt-1 text-xs" style={{ color: "var(--warn)" }}>
                    ⚠ Missing {missing.map((v) => `{${v}}`).join(", ")} — a florist would be left with no address to write to.
                  </p>
                )}
                {locale !== "en" && (
                  <p className="mt-1 text-xs text-ink-faint">
                    EN: <span className="text-ink-soft">{enReference(field.key)}</span>
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => saveGroup(group)}
            disabled={dirty.length === 0 || busy}
            className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-ink disabled:opacity-50"
          >
            {busy ? "Saving…" : dirty.length > 0 ? `Save ${dirty.length} change${dirty.length > 1 ? "s" : ""}` : "Save"}
          </button>
          <button
            type="button"
            onClick={() => revertGroup(group)}
            disabled={overridden.length === 0 || busy}
            className="rounded-md border border-line-strong px-3 py-1 text-xs font-medium text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
            title={overridden.length ? undefined : "Nothing edited here yet"}
          >
            Revert to default
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <p className="eyebrow">Backoffice</p>
      <h1>Florist Q&amp;A</h1>
      <p className="mt-2 text-sm text-ink-soft">
        The answers florists read at <code>/help</code> (public, linked from the offer and recruiting emails) and at{" "}
        <code>/florist/help</code> (inside the app, from the “I have a question first” button on an offer). Edits are
        stored as runtime overrides on top of the built-in copy and take effect immediately, with no deploy.
      </p>
      <p className="mt-2 text-sm text-ink-faint">
        Which questions exist, and their order, live in code (<code>lib/help/content.ts</code>) and need a deploy to
        change. Everything a florist reads is editable here.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-md border border-line-strong p-1">
          {locales.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => selectLocale(l)}
              className={`rounded px-3 py-1 text-sm font-medium ${
                locale === l ? "bg-accent text-white" : "text-ink-soft hover:bg-surface-2"
              }`}
            >
              {l.toUpperCase()} <span className="hidden sm:inline">· {LOCALE_LABEL[l]}</span>
            </button>
          ))}
        </div>
        <a
          href={`/help?locale=${locale}`}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2"
        >
          Open the page ({locale.toUpperCase()}) →
        </a>
      </div>

      <div className="mt-8 space-y-4">
        {renderGroup(CHROME)}
        {renderGroup(CATEGORY_LABEL_GROUP)}
      </div>

      {sections.map(({ category, groups }) => (
        <section key={category} className="mt-10">
          <h2 className="text-sm font-semibold text-ink">{valueFor(`ui.help.cat.${category}`)}</h2>
          {CATEGORY_HINT[category] && <p className="mt-1 text-xs text-ink-faint">{CATEGORY_HINT[category]}</p>}
          <div className="mt-3 space-y-4">{groups.map(renderGroup)}</div>
        </section>
      ))}

      <SimpleToast toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
