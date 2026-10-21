// Route-level loading skeleton for `/city/[id]` — shown by Next.js while the
// server component in page.tsx awaits the Supabase queries. Mirrors
// DashboardClient's viewport-locked workbench layout (header, meta row,
// vitals bar, rail + map + table) with pulsing placeholders instead of a
// spinner, matching the pattern in app/loading.tsx.
export default function Loading() {
  return (
    <div className="flex h-screen flex-col bg-surface-2">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface px-6">
        <div className="h-4 w-48 animate-pulse rounded bg-surface-2" />
        <div className="flex items-center gap-3">
          <div className="h-8 w-24 animate-pulse rounded-md bg-surface-2" />
          <div className="h-8 w-8 animate-pulse rounded-full bg-surface-2" />
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 py-4">
        <div className="h-3 w-72 shrink-0 animate-pulse rounded bg-surface-2" />

        <div className="h-14 shrink-0 animate-pulse rounded-lg border border-line bg-surface shadow-sm" />

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[300px_1fr]">
          <div className="hidden rounded-lg border border-line bg-surface p-4 shadow-sm lg:block">
            <div className="h-4 w-20 animate-pulse rounded bg-surface-2" />
            <div className="mt-4 space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="h-3 w-24 animate-pulse rounded bg-surface-2" />
                  <div className="h-2 w-full animate-pulse rounded-full bg-surface-2" />
                </div>
              ))}
            </div>
          </div>

          <div className="flex min-h-0 flex-col gap-4">
            <div className="h-[340px] shrink-0 animate-pulse rounded-lg border border-line bg-surface-2" />
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
              <div className="h-9 border-b border-line bg-surface-2" />
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-center gap-4 border-b border-line px-4 py-3 last:border-0"
                >
                  <div className="h-4 w-32 animate-pulse rounded bg-surface-2" />
                  <div className="h-4 w-16 animate-pulse rounded-full bg-surface-2" />
                  <div className="h-4 w-12 animate-pulse rounded bg-surface-2" />
                  <div className="ml-auto h-4 w-16 animate-pulse rounded bg-surface-2" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
