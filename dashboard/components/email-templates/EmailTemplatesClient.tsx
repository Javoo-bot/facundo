"use client";

import { useMemo } from "react";
import SimpleToast from "@/components/SimpleToast";
import { missingVars, expectedVars } from "@/lib/i18n/varsManifest";
import { useCopyOverrides, type OverrideRow } from "@/lib/useCopyOverrides";
import type { Locale, MessageTree } from "@/lib/i18n";

export type { OverrideRow };

const LOCALE_LABEL: Record<Locale, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  de: "Deutsch",
  pt: "Português",
};

const SECTION_LABEL: Record<string, string> = {
  "email.shell": "Shared shell",
  "email.offer": "Offer email (to florist)",
  "email.client": "Client notices",
  "email.issue": "Issue emails (to florist)",
  issueLabel: "Issue type labels",
  sms: "Offer SMS (to florist)",
};

// Namespace = every segment but the leaf, EXCEPT the top level ("issueLabel",
// "sms") which has no further nesting — "email.offer.subject" ->
// "email.offer", "issueLabel.missing_ingredient" -> "issueLabel",
// "sms.offer.body" -> "sms". Matches the 5 groups called out in the brief
// (email.shell/offer/client/issue + issueLabel) plus the later-added "sms"
// group for the offer-SMS catalog copy (lib/offerSmsContent.ts).
function namespaceOf(key: string): string {
  const parts = key.split(".");
  return parts[0] === "email" ? parts.slice(0, 2).join(".") : parts[0];
}

export default function EmailTemplatesClient({
  keys,
  locales,
  catalogs,
  overrides: initialOverrides,
}: {
  keys: string[];
  locales: Locale[];
  catalogs: Record<Locale, MessageTree>;
  overrides: OverrideRow[];
}) {
  // Resolution, drafts and the save/revert round-trips are shared with the
  // Q&A editor (/faq) — see lib/useCopyOverrides.ts.
  const {
    locale, selectLocale, effective, valueFor, isDirty, hasOverride, enReference,
    setDraft, saveKey, revertKey, busyKey, setBusyKey, toasts, push, dismiss,
  } = useCopyOverrides({ catalogs, initialOverrides });

  const save = async (key: string) => {
    setBusyKey(key);
    try {
      if (await saveKey(key)) push("success", `Saved override for ${key}.`);
    } finally {
      setBusyKey(null);
    }
  };

  const revert = async (key: string) => {
    setBusyKey(key);
    try {
      if (await revertKey(key)) push("success", `Reverted ${key} to its default.`);
    } finally {
      setBusyKey(null);
    }
  };

  const grouped = useMemo(() => {
    const order: string[] = [];
    const byNamespace = new Map<string, string[]>();
    for (const key of keys) {
      const ns = namespaceOf(key);
      if (!byNamespace.has(ns)) {
        byNamespace.set(ns, []);
        order.push(ns);
      }
      byNamespace.get(ns)!.push(key);
    }
    return order.map((ns) => ({ ns, keys: byNamespace.get(ns)! }));
  }, [keys]);

  const openPreview = () => {
    window.open(`/api/settings/message-overrides/preview?locale=${locale}`, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <p className="eyebrow">Backoffice</p>
      <h1>Email templates</h1>
      <p className="mt-2 text-sm text-ink-soft">
        View and edit every copy string across all 6 locales. Edits are stored as runtime overrides layered on
        top of the built-in copy — they take effect immediately, with no deploy.
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
        <button
          type="button"
          onClick={openPreview}
          className="rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2"
        >
          Preview offer email ({locale.toUpperCase()}) →
        </button>
      </div>

      <div className="mt-6 space-y-8">
        {grouped.map(({ ns, keys: nsKeys }) => (
          <section key={ns}>
            <h2 className="text-sm font-semibold text-ink">{SECTION_LABEL[ns] ?? ns}</h2>
            <div className="mt-3 space-y-4">
              {nsKeys.map((key) => {
                const { source } = effective(key);
                const draftValue = valueFor(key);
                const dirty = isDirty(key);
                const missing = missingVars(key, draftValue);
                const hasVars = expectedVars(key).length > 0;
                const overridden = hasOverride(key);

                return (
                  <div key={key} className="rounded-lg border p-3" style={{ borderColor: "var(--line)" }}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <code className="text-xs text-ink-faint">{key}</code>
                      <span
                        className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                        style={{
                          background:
                            source === "override"
                              ? "color-mix(in srgb, var(--accent) 15%, transparent)"
                              : source === "locale-default"
                              ? "color-mix(in srgb, var(--ink) 8%, transparent)"
                              : "color-mix(in srgb, var(--warn) 15%, transparent)",
                          color: source === "override" ? "var(--accent)" : source === "locale-default" ? "var(--ink-soft)" : "var(--warn)",
                        }}
                      >
                        {source === "override" ? "override" : source === "locale-default" ? `${locale} default` : "EN fallback"}
                      </span>
                    </div>

                    {locale !== "en" && (
                      <p className="mt-2 text-xs text-ink-faint">
                        EN reference: <span className="text-ink-soft">{enReference(key)}</span>
                      </p>
                    )}
                    {hasVars && (
                      <p className="mt-1 text-xs text-ink-faint">
                        Vars: {expectedVars(key).map((v) => `{${v}}`).join(", ")}
                      </p>
                    )}

                    <textarea
                      value={draftValue}
                      onChange={(e) => setDraft(key, e.target.value)}
                      rows={draftValue.length > 90 ? 3 : 2}
                      className="mt-2 w-full rounded-md border border-line-strong px-3 py-1.5 text-sm"
                    />
                    {missing.length > 0 && (
                      <p className="mt-1 text-xs" style={{ color: "var(--warn)" }}>
                        ⚠ Missing {missing.map((v) => `{${v}}`).join(", ")} — this send site expects it.
                      </p>
                    )}

                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => save(key)}
                        disabled={!dirty || busyKey === key}
                        className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-ink disabled:opacity-50"
                      >
                        {busyKey === key ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => revert(key)}
                        disabled={!overridden || busyKey === key}
                        className="rounded-md border border-line-strong px-3 py-1 text-xs font-medium text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
                        title={overridden ? undefined : "No override set for this key/locale"}
                      >
                        Revert to default
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <SimpleToast toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
