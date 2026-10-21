"use client";

import { createContext, useContext } from "react";
import { t, DEFAULT_LOCALE, type Locale } from "@/lib/i18n";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

/** Provides the signed-in florist's locale to every client component below it.
 * No internal state on purpose: `locale` is a plain prop mirrored straight
 * into context, so a parent re-render (e.g. after the language picker calls
 * router.refresh()) flows through automatically — no effect, no client
 * re-fetch. Falls back to DEFAULT_LOCALE (English) for any tree that renders
 * outside a florist context (e.g. a shared component also used on a staff
 * page), so components using useT() are always safe to render anywhere. */
export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

/** Client-component hook: current locale + a bound `t()` for the florist
 * catalog's `ui.*` (and, if ever needed client-side, `email.*`) keys. */
export function useT() {
  const locale = useContext(LocaleContext);
  return { locale, t: (key: string, vars?: Record<string, string | number>) => t(locale, key, vars) };
}
