"use client";

import type { City } from "@/lib/types";

export default function CitySelector({
  cities,
  selectedCityId,
  onChange,
}: {
  cities: City[];
  selectedCityId: string | null;
  onChange: (cityId: string) => void;
}) {
  return (
    <div>
      <label
        htmlFor="city-selector"
        className="block text-xs font-semibold uppercase tracking-wide text-ink-soft"
      >
        City
      </label>
      {cities.length === 0 ? (
        <p className="mt-1 text-sm text-ink-soft">No cities ingested yet.</p>
      ) : (
        <select
          id="city-selector"
          value={selectedCityId ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded-md border border-line-strong bg-surface px-2 py-1.5 text-sm shadow-sm focus:border-ink-faint focus:outline-none"
        >
          {cities.map((c) => (
            <option key={c.id} value={c.id}>
              {c.city}, {c.country}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
