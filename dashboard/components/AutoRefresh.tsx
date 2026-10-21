"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps a server-rendered page live without a manual reload. Calls
 * `router.refresh()` on an interval, which re-runs the current route's Server
 * Component data fetch (RLS-scoped, same as a full load) and reconciles the DOM
 * in place — client component state (open forms, filters, scroll) is preserved,
 * only the server-provided data updates.
 *
 * Behaviour:
 * - Pauses while the tab is hidden (no point polling a background tab — saves
 *   Supabase reads and battery).
 * - Refreshes immediately on tab re-focus, so returning shows current data at
 *   once rather than after the next tick.
 *
 * Mounted once in the (staff) layout so every staff console route is live; drop
 * it into a specific page with a different `intervalMs` if a page needs its own
 * cadence.
 */
export default function AutoRefresh({ intervalMs = 60000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      // Only refresh a visible tab. `router.refresh()` is a no-op-ish soft
      // refresh, but skipping hidden tabs avoids needless server round-trips.
      if (document.visibilityState === "visible") router.refresh();
    };

    const start = () => {
      if (timer === null) timer = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        router.refresh(); // catch up immediately on return
        start();
      } else {
        stop();
      }
    };

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, intervalMs]);

  return null;
}
