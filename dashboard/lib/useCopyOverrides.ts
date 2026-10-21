"use client";

import { useState } from "react";
import { useToasts } from "@/lib/useToasts";
import { LOCALES, type Locale, type MessageTree } from "@/lib/i18n";

export interface OverrideRow {
  locale: Locale;
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
}

/** Where the string a staff member is looking at actually came from. */
export type CopySource = "override" | "locale-default" | "en-fallback";

/** Same dot-path walk as lib/i18n/index.ts's private `lookup`, over the plain
 * catalogs the server page passes down (not lib/i18n's internal CATALOG).
 * Never throws; undefined = "this locale hasn't translated this leaf", which is
 * a legitimate state rather than an error. */
export function lookupPath(tree: MessageTree, key: string): string | undefined {
  let node: string | MessageTree | undefined = tree;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = node[segment];
  }
  return typeof node === "string" ? node : undefined;
}

/**
 * The editing model shared by every staff surface that edits catalog copy:
 * /email-templates (the flat key list) and /faq (the Q&A, article-shaped).
 *
 * It owns the three-layer resolution (DB override → this locale's catalog
 * string → EN fallback), the per-locale draft buffer, and the save/revert
 * round-trips against /api/settings/message-overrides. Extracted when the Q&A
 * editor landed rather than copied: the two pages present very different UIs
 * over identical semantics, and a second hand-maintained copy of "what does
 * this key currently resolve to" is exactly the thing that drifts.
 *
 * It is also where the locale map is built from LOCALES rather than a literal.
 * The previous inline version listed `{ en, fr, es, it, de }` and had silently
 * missed `pt` since that locale was added, so any Portuguese override row threw
 * on load and switching to PT crashed the page.
 */
export function useCopyOverrides({
  catalogs,
  initialOverrides,
}: {
  catalogs: Record<Locale, MessageTree>;
  initialOverrides: OverrideRow[];
}) {
  const [locale, setLocale] = useState<Locale>("en");
  // Saved DB state (the source of truth), locale -> key -> value. Updated in
  // place after a successful POST/DELETE so the UI matches what's persisted
  // without refetching the page.
  const [overridesByLocale, setOverridesByLocale] = useState<Record<Locale, Record<string, string>>>(() => {
    const map = Object.fromEntries(LOCALES.map((l) => [l, {}])) as Record<Locale, Record<string, string>>;
    for (const row of initialOverrides) {
      // A row for a locale that has since been removed from LOCALES would
      // otherwise throw here. Ignore it — the catalog no longer serves it.
      if (map[row.locale]) map[row.locale][row.key] = row.value;
    }
    return map;
  });
  // In-progress edits for the CURRENTLY selected locale only. Cleared when the
  // locale changes: switching before saving discards that locale's unsaved
  // edits, the same as leaving any other form in this app without saving.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const { toasts, push, dismiss } = useToasts();

  const effective = (key: string): { value: string; source: CopySource } => {
    const override = overridesByLocale[locale]?.[key];
    if (override !== undefined) return { value: override, source: "override" };
    const localeDefault = lookupPath(catalogs[locale], key);
    if (localeDefault !== undefined) return { value: localeDefault, source: "locale-default" };
    return { value: lookupPath(catalogs.en, key) ?? key, source: "en-fallback" };
  };

  const valueFor = (key: string): string => (key in drafts ? drafts[key] : effective(key).value);
  const isDirty = (key: string): boolean => key in drafts && drafts[key] !== effective(key).value;
  const hasOverride = (key: string): boolean => overridesByLocale[locale]?.[key] !== undefined;
  const enReference = (key: string): string => lookupPath(catalogs.en, key) ?? key;

  const setDraft = (key: string, value: string) => setDrafts((prev) => ({ ...prev, [key]: value }));
  const clearDraft = (key: string) =>
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const selectLocale = (next: Locale) => {
    setLocale(next);
    setDrafts({});
  };

  /** Persists one key. Returns true on success so callers saving several keys
   * (the Q&A editor saves a whole article at once) can report honestly on a
   * partial failure instead of claiming a clean save. */
  const saveKey = async (key: string): Promise<boolean> => {
    const value = valueFor(key);
    if (value.trim().length === 0) {
      push("error", "Value can't be empty.");
      return false;
    }
    const res = await fetch("/api/settings/message-overrides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale, key, value }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      push("error", j.error || `Save failed (${res.status}).`);
      return false;
    }
    setOverridesByLocale((prev) => ({ ...prev, [locale]: { ...prev[locale], [key]: value } }));
    clearDraft(key);
    return true;
  };

  /** Drops one key's override, falling back to the built-in copy. A key with
   * no override is a no-op success — reverting a whole article shouldn't fail
   * because only some of its fields were customised. */
  const revertKey = async (key: string): Promise<boolean> => {
    if (!hasOverride(key)) {
      clearDraft(key);
      return true;
    }
    const res = await fetch("/api/settings/message-overrides", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale, key }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      push("error", j.error || `Revert failed (${res.status}).`);
      return false;
    }
    setOverridesByLocale((prev) => {
      const nextLocale = { ...prev[locale] };
      delete nextLocale[key];
      return { ...prev, [locale]: nextLocale };
    });
    clearDraft(key);
    return true;
  };

  return {
    locale,
    selectLocale,
    effective,
    valueFor,
    isDirty,
    hasOverride,
    enReference,
    setDraft,
    saveKey,
    revertKey,
    busyKey,
    setBusyKey,
    toasts,
    push,
    dismiss,
  };
}
