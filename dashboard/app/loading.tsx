// Route-level loading skeleton for `/` — shown by Next.js while the server
// component in app/page.tsx awaits the Supabase queries. Mirrors
// PipelineHome's Discovery-view layout (sticky header, stat tile grid, cities
// table) with pulsing placeholders instead of a spinner, so the page doesn't
// visually jump once real data lands.
export default function Loading() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-slate-200 bg-white px-6">
        <div className="h-4 w-56 animate-pulse rounded bg-slate-200" />
        <div className="flex items-center gap-3">
          <div className="h-8 w-24 animate-pulse rounded-md bg-slate-200" />
          <div className="h-8 w-8 animate-pulse rounded-full bg-slate-200" />
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-6 py-6">
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="mb-3 h-7 w-7 animate-pulse rounded-md bg-slate-100" />
              <div className="h-6 w-12 animate-pulse rounded bg-slate-200" />
              <div className="mt-2 h-3 w-16 animate-pulse rounded bg-slate-100" />
            </div>
          ))}
        </section>

        <section className="mt-8">
          <div className="mb-3 flex items-baseline justify-between">
            <div className="h-5 w-20 animate-pulse rounded bg-slate-200" />
            <div className="h-3 w-32 animate-pulse rounded bg-slate-100" />
          </div>

          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="h-9 border-b border-slate-200 bg-slate-50" />
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-4 border-b border-slate-100 px-4 py-3 last:border-0"
              >
                <div className="h-4 w-32 animate-pulse rounded bg-slate-100" />
                <div className="h-4 w-12 animate-pulse rounded bg-slate-100" />
                <div className="h-4 w-16 animate-pulse rounded-full bg-slate-100" />
                <div className="h-4 w-16 animate-pulse rounded bg-slate-100" />
                <div className="h-4 w-20 animate-pulse rounded-full bg-slate-100" />
                <div className="ml-auto h-4 w-16 animate-pulse rounded bg-slate-100" />
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
