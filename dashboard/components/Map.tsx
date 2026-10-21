"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import BoolBadge from "@/components/BoolBadge";
import MapLegend from "@/components/MapLegend";
import RatingChip from "@/components/RatingChip";
import { IconExternalLink, IconMail, IconPhone } from "@/components/icons";
import type { City, Florist } from "@/lib/types";

const SPREAD_PANE = "spread-pane";

// Rating band colors per the brief. Null rating gets its own honest "unknown"
// color rather than being fabricated into a band.
function ratingColor(rating: number | null): string {
  if (rating == null) return "#94a3b8"; // slate-400 — unknown
  if (rating >= 4.5) return "#22c55e"; // green-500
  if (rating >= 4.3) return "#84cc16"; // lime-500
  if (rating >= 4.0) return "#f59e0b"; // amber-500
  return "#ef4444"; // red-500
}

// `highlighted` is the hover state — purely visual (size bump + colored
// ring), never opens a popup. See the FloristMap component doc comment for
// why hover and popups are decoupled.
function buildCircleIcon(
  color: string,
  opts?: { size?: number; ring?: boolean; highlighted?: boolean }
): L.DivIcon {
  const baseSize = opts?.size ?? 16;
  const size = opts?.highlighted ? baseSize + 6 : baseSize;
  let strokeColor = "white";
  let strokeWidth = 1.5;
  if (opts?.ring) {
    strokeColor = "#1e293b";
    strokeWidth = 3;
  }
  if (opts?.highlighted) {
    // Fix (current-code defect #5): the hover ring was blue-600, which is
    // off the emerald/slate/red palette used everywhere else on this page.
    strokeColor = opts?.ring ? "#1e293b" : "#059669"; // emerald-600 hover ring
    strokeWidth = 3.5;
  }
  const stroke = `"${strokeColor}" stroke-width="${strokeWidth}"`;
  const html = `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="${color}" stroke=${stroke} /></svg>`;
  return L.divIcon({
    html,
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

function buildStarIcon(): L.DivIcon {
  const html = `<svg width="30" height="30" viewBox="0 0 24 24"><path d="M12 2l2.9 6.26L22 9.27l-5 4.87L18.2 22 12 18.27 5.8 22 7 14.14l-5-4.87 7.1-1.01L12 2z" fill="#7c3aed" stroke="#312e81" stroke-width="1"/></svg>`;
  return L.divIcon({
    html,
    className: "",
    iconSize: [30, 30],
    iconAnchor: [15, 22],
    popupAnchor: [0, -20],
  });
}

/** Re-centers the map whenever the selected city changes. */
function RecenterMap({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center[0], center[1], zoom, map]);
  return null;
}

/** Registers a dedicated pane so spread-selected pins reliably render above
 * the base rating-colored pins, regardless of DOM insertion order. */
function SpreadPaneSetup() {
  const map = useMap();
  useEffect(() => {
    if (!map.getPane(SPREAD_PANE)) {
      const pane = map.createPane(SPREAD_PANE);
      pane.style.zIndex = "650";
    }
  }, [map]);
  return null;
}

function FloristPopup({
  florist,
  onSelectFlorist,
}: {
  florist: Florist;
  onSelectFlorist: (florist: Florist) => void;
}) {
  const phone = florist.phone_web ?? florist.phone_maps;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold text-ink">{florist.name}</span>
        {florist.website_url && (
          <a
            href={florist.website_url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${florist.name}'s website in a new tab`}
            title="Open website"
            className="mt-0.5 shrink-0 text-ink-faint hover:text-accent"
          >
            <IconExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      <div className="flex items-center gap-2">
        <RatingChip rating={florist.rating} reviews={florist.review_count} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <BoolBadge label="Website" value={florist.has_website} />
        <BoolBadge label="Ecommerce" value={florist.is_ecommerce} />
      </div>

      <div className="space-y-1 text-ink-soft">
        {florist.email && (
          <div className="flex items-center gap-1.5">
            <IconMail className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            <a href={`mailto:${florist.email}`} className="text-accent hover:underline">
              {florist.email}
            </a>
          </div>
        )}
        {phone && (
          <div className="flex items-center gap-1.5">
            <IconPhone className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            <a href={`tel:${phone}`} className="text-accent hover:underline">
              {phone}
            </a>
          </div>
        )}
      </div>

      {florist.distance_km_from_center != null && (
        <div className="text-xs tabular-nums text-ink-soft">
          {florist.distance_km_from_center.toFixed(2)} km from center
        </div>
      )}

      <button
        type="button"
        onClick={() => onSelectFlorist(florist)}
        className="mt-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent-ink"
      >
        Show breakdown
      </button>
    </div>
  );
}

export interface MapProps {
  city: City;
  florists: Florist[];
  spreadIds: Set<string>;
  hoveredId: string | null;
  // The florist whose ScoreBreakdown panel is open (row click or "Show
  // breakdown"). Drives which pin's popup is programmatically opened —
  // decoupled from hover so hover can't win a race with the popup it just
  // opened (see the fix note below).
  selectedId: string | null;
  onHoverFlorist: (id: string | null) => void;
  onSelectFlorist: (florist: Florist) => void;
}

export default function FloristMap({
  city,
  florists,
  spreadIds,
  hoveredId,
  selectedId,
  onHoverFlorist,
  onSelectFlorist,
}: MapProps) {
  // Named FloristMap (not `Map`) to avoid shadowing the global ES `Map` used
  // below for markerRefs — a component named `Map` hoists into module scope
  // and shadows `new Map()` everywhere in this file.
  const markerRefs = useRef(new globalThis.Map<string, L.Marker>());
  const openedByEffectRef = useRef<string | null>(null);

  // Fix for the unreachable-popup bug: hover used to open a marker's popup
  // and close it again on mouseleave, so the cursor could never reach the
  // popup (the "Show breakdown" button lives inside it) before it vanished.
  // Hover is now purely visual (pin highlight below) and carries no popup
  // side effect. Clicking a row or a pin is what opens a popup, and that
  // popup is persistent: it stays open until the user closes it or a
  // different florist becomes selected. Table-row clicks flow through
  // `selectedId`; pin clicks open their own popup natively via Leaflet
  // (Marker + child Popup), which this effect doesn't need to duplicate —
  // it only needs to (a) mirror a row-driven selection onto the map and
  // (b) close whichever popup it previously opened when the selection
  // changes to someone else.
  useEffect(() => {
    if (openedByEffectRef.current && openedByEffectRef.current !== selectedId) {
      markerRefs.current.get(openedByEffectRef.current)?.closePopup();
    }
    if (selectedId) {
      markerRefs.current.get(selectedId)?.openPopup();
    }
    openedByEffectRef.current = selectedId;
  }, [selectedId]);

  // Null-guard: florists with no lat/lng can't be plotted.
  const plottable = florists.filter(
    (f): f is Florist & { lat: number; lng: number } => f.lat != null && f.lng != null
  );
  const spreadPlottable = plottable.filter((f) => spreadIds.has(f.id));

  const center: [number, number] = [city.center_lat, city.center_lng];

  return (
    <div className="relative h-full w-full">
      {/* The map is a visual aid only — every plotted florist also appears
       * as a row in the table below, which is the accessible data source
       * (sortable, keyboard-navigable, no drag/zoom required). */}
      <p className="sr-only">
        Map showing florist locations color-coded by rating band. The table below lists the
        same florists and is the accessible way to browse this data.
      </p>
      <MapContainer center={center} zoom={12} className="h-full w-full" scrollWheelZoom>
        <RecenterMap center={center} zoom={12} />
        <SpreadPaneSetup />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <Marker position={center} icon={buildStarIcon()}>
          <Popup>
            <div className="text-sm font-medium">
              {city.city}, {city.country}
            </div>
            <div className="text-xs text-ink-soft">City center</div>
          </Popup>
        </Marker>

        {plottable.map((florist) => (
          <Marker
            key={florist.id}
            position={[florist.lat, florist.lng]}
            icon={buildCircleIcon(ratingColor(florist.rating), { highlighted: hoveredId === florist.id })}
            ref={(instance) => {
              if (instance) markerRefs.current.set(florist.id, instance);
            }}
            eventHandlers={{
              // Hover is visual-only (pin highlight above) — it never opens or
              // closes a popup, which is exactly what used to cause the
              // unreachable-popup bug (open-on-hover, close-on-mouseleave
              // raced the cursor moving toward the popup's button).
              mouseover: () => onHoverFlorist(florist.id),
              mouseout: () => onHoverFlorist(null),
              popupclose: () => {
                if (openedByEffectRef.current === florist.id) openedByEffectRef.current = null;
              },
            }}
          >
            <Popup>
              <FloristPopup florist={florist} onSelectFlorist={onSelectFlorist} />
            </Popup>
          </Marker>
        ))}

        {/* Spread-selected layer: larger pin with a dark ring, on top via the
            dedicated higher-z-index pane. Re-registering the marker ref here
            (same florist id) means hover-sync always targets the topmost pin. */}
        {spreadPlottable.map((florist) => (
          <Marker
            key={`spread-${florist.id}`}
            position={[florist.lat, florist.lng]}
            icon={buildCircleIcon(ratingColor(florist.rating), {
              size: 26,
              ring: true,
              highlighted: hoveredId === florist.id,
            })}
            pane={SPREAD_PANE}
            ref={(instance) => {
              if (instance) markerRefs.current.set(florist.id, instance);
            }}
            eventHandlers={{
              mouseover: () => onHoverFlorist(florist.id),
              mouseout: () => onHoverFlorist(null),
              popupclose: () => {
                if (openedByEffectRef.current === florist.id) openedByEffectRef.current = null;
              },
            }}
          >
            <Popup>
              <FloristPopup florist={florist} onSelectFlorist={onSelectFlorist} />
            </Popup>
          </Marker>
        ))}
      </MapContainer>
      <MapLegend />
    </div>
  );
}
