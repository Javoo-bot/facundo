"use client";

import { useRouter } from "next/navigation";
import { IconAlertTriangle } from "@/components/icons";

// Distinct from EmptyState on purpose — an outage must never look like "0
// cities"/"0 florists" (see the app/page.tsx and app/city/[id]/page.tsx
// fixes: query `error`s are captured and passed through instead of being
// swallowed behind `?? []`). Generalized with title/description/retry props
// (not forked) so the city page's fetch-error state reuses this component —
// per docs/superpowers/specs/2026-07-02-city-page-redesign-brief.md
// "Generalize (add props, don't duplicate)".
export default function ErrorState({
  title = "Couldn't load cities",
  description = "Something went wrong fetching data from Supabase. This is a fetch error, not an empty account — your cities are still there.",
  onRetry,
}: {
  title?: string;
  description?: string;
  /** Defaults to a full `router.refresh()` — override for a different retry
   * action (rarely needed). */
  onRetry?: () => void;
}) {
  const router = useRouter();
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface px-6 py-16 text-center shadow-sm">
      <IconAlertTriangle className="h-12 w-12 text-crit" />
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="max-w-sm text-sm text-ink-soft">{description}</p>
      <button
        type="button"
        onClick={onRetry ?? (() => router.refresh())}
        className="mt-2 rounded-md border border-line-strong bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-2 active:scale-[0.98]"
      >
        Retry
      </button>
    </div>
  );
}
