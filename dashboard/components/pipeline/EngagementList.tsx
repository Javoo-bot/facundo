import Link from "next/link";
import type { City, PipelineFlorist } from "@/lib/types";

// Cross-city list of florists in a given phase — a linkable row per florist.
export default function EngagementList({
  florists,
  cities,
  emptyLabel,
}: {
  florists: PipelineFlorist[];
  cities: City[];
  emptyLabel: string;
}) {
  if (florists.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-line px-3 py-8 text-center text-sm text-ink-faint">
        {emptyLabel}
      </p>
    );
  }
  const cityName = new Map(cities.map((c) => [c.id, c.city]));
  return (
    <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
      {florists.map((f) => (
        <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <div className="min-w-0">
            <Link href={`/florists/${f.id}`} className="font-medium text-ink hover:text-accent-ink hover:underline">
              {f.name}
            </Link>
            <span className="ml-2 text-xs text-ink-faint">{cityName.get(f.city_id) ?? "—"}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-ink-soft">
            {f.email && <span className="hidden sm:inline">{f.email}</span>}
            {f.rating != null && <span>★ {f.rating.toFixed(1)}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
