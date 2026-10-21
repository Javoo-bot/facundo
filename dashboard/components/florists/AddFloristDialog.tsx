"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import { placeHoursToBusinessHours } from "@/lib/placeHours";
import type { BusinessHours } from "@/lib/businessHours";

/** Add a florist we already work with by hand, and get their join link.
 *
 * Three steps in one dialog: find them on Maps, check what we pulled, add what
 * only you know. The split matters — everything Google can tell us is filled in
 * before you type anything, so the fields you DO fill are exactly the ones that
 * carry information Google doesn't have: the mobile you text them on, who you
 * talk to, and the two values without which they can never be matched.
 *
 * The Places calls go through /api/places/staff (staff-authenticated), NOT the
 * join-token-gated public routes. */

interface Suggestion {
  placeId: string;
  primary: string;
  secondary: string;
}

interface RichPlace {
  placeId: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  website: string | null;
  periods: unknown[] | null;
  rating: number | null;
  reviewCount: number | null;
}

interface Created {
  floristId: string;
  name: string;
  joinUrl: string;
  expiresAt: string;
  city: { id: string; name: string; country: string; created: boolean };
}

const DEBOUNCE_MS = 250;
const field = { width: "100%", padding: "9px 11px", fontSize: ".9rem" } as const;

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: ".8rem", fontWeight: 600 }}>
      <span>
        {label}
        {hint && <span style={{ fontWeight: 400, color: "var(--ink-faint)" }}> {hint}</span>}
      </span>
      {children}
    </label>
  );
}

export default function AddFloristDialog({
  tiers,
  onClose,
  onCreated,
}: {
  /** Trust tier codes from the trust_tiers table, so this never hardcodes a
   * list that the settings page can change underneath it. */
  tiers: readonly string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [place, setPlace] = useState<RichPlace | null>(null);
  const [hoursNote, setHoursNote] = useState<string | null>(null);
  const [businessHours, setBusinessHours] = useState<BusinessHours | null>(null);

  const [mobile, setMobile] = useState("");
  const [owner, setOwner] = useState("");
  const [email, setEmail] = useState("");
  const [radius, setRadius] = useState("10");
  const [tier, setTier] = useState(tiers[0] ?? "");
  const [stage, setStage] = useState("production");
  const [notes, setNotes] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [cityName, setCityName] = useState("");
  const [needsCity, setNeedsCity] = useState(false);
  // Off-maps mode: the shop has no Google listing, so the search box looks up
  // its STREET ADDRESS instead. The business may be unlisted; the street is not.
  const [offMaps, setOffMaps] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualPhone, setManualPhone] = useState("");
  const [manualSite, setManualSite] = useState("");
  const [confirmDup, setConfirmDup] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);

  const session = useRef<string>("");
  const queryId = useRef(0);
  const ensureSession = () => (session.current ||= crypto.randomUUID());

  const post = useCallback(async (payload: Record<string, unknown>) => {
    const res = await fetch("/api/places/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok ? await res.json() : null;
  }, []);

  useEffect(() => {
    if (place || query.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    const id = ++queryId.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      const j = await post({ action: "search", input: query.trim(), sessionToken: ensureSession() });
      if (id !== queryId.current) return; // a newer keystroke won
      setSuggestions(j?.suggestions ?? []);
      setSearching(false);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, place, post]);

  const pick = async (s: Suggestion) => {
    setSuggestions([]);
    setQuery(s.primary);
    const j = await post({ action: "details", placeId: s.placeId, sessionToken: ensureSession() });
    const p: RichPlace | null = j?.place ?? null;
    session.current = ""; // this pick closes the billing session
    if (!p) {
      setError("Could not load that place from Google. Try another result.");
      return;
    }
    setPlace(p);

    const { hours, skipped } = placeHoursToBusinessHours(p.periods as never);
    setBusinessHours(hours);
    // Say what we could NOT import, rather than implying the hours are complete.
    setHoursNote(
      skipped.length > 0
        ? `${skipped.map((s) => s.day).join(", ")} not imported (${skipped[0].reason}) — the florist will fill these in.`
        : hours
          ? "Opening hours imported from Maps."
          : "Google has no opening hours for this shop."
    );
  };

  const submit = async () => {
    if (!place) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/florists/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Blank in off-maps mode — the server mints a MANUAL- id.
          place_id: offMaps ? "" : place.placeId,
          name: offMaps ? manualName : place.name,
          address: place.address,
          lat: place.lat,
          lng: place.lng,
          website_url: offMaps ? manualSite : place.website,
          phone_web: offMaps ? manualPhone : place.phone,
          business_hours: businessHours,
          phone_mobile: mobile,
          email,
          owner_name: owner,
          delivery_radius_km: Number(radius),
          trust_tier: tier,
          lifecycle_stage: stage,
          source_notes: notes,
          country: countryCode,
          city_name: cityName,
          confirm_duplicate_name: confirmDup,
        }),
      });
      const j = await res.json();
      if (!res.ok) {
        // 400 with this text means no existing city covers the shop; ask for the
        // two fields needed to file it rather than failing the whole dialog.
        if (res.status === 400 && typeof j.error === "string" && j.error.includes("country and city name")) {
          setNeedsCity(true);
        }
        // A name collision is a warning, not a wall: a second branch on another
        // street is legitimate. Confirming re-submits past the check.
        if (res.status === 409 && j.confirmable) setConfirmDup(true);
        setError(j.message ?? j.error ?? "Could not create the florist.");
        return;
      }
      setCreated(j as Created);
      onCreated();
    } catch {
      setError("Could not reach the server. Nothing was created.");
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created.joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Exactly what is still missing, in the order the form asks for it. A
  // disabled Create button with no explanation is what made the off-maps path
  // feel broken rather than incomplete.
  const blockedBy = !place
    ? offMaps
      ? "Pick their street from the list above so we have their location."
      : "Pick the shop from the Maps list above."
    : offMaps && !manualName.trim()
      ? "Enter the shop name."
      : !mobile.trim() && !email.trim()
        ? "Add a mobile or an email — we need one way to send them orders."
        : !tier
          ? "Choose a trust tier."
          : null;

  return (
    <div
      className="animate-overview-backdrop-fade"
      style={{ position: "fixed", inset: 0, background: "rgba(10,20,15,.45)", display: "grid", placeItems: "center", zIndex: 60, padding: 16 }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="card animate-overview-dialog-pop"
        role="dialog"
        aria-modal="true"
        aria-label="Add a florist"
        style={{ width: "100%", maxWidth: 480, maxHeight: "90vh", overflowY: "auto", display: "grid", gap: 14 }}
      >
        {created ? (
          <>
            <h2 style={{ margin: 0, fontSize: "1.05rem" }}>{created.name} is in</h2>
            <p style={{ margin: 0, fontSize: ".85rem", color: "var(--ink-soft)", lineHeight: 1.5 }}>
              Send them this link. It pre-fills everything we just pulled, so they only confirm it and add
              their hours. Valid until {new Date(created.expiresAt).toLocaleDateString()}.
            </p>
            <code
              style={{ fontSize: ".76rem", background: "var(--surface-2)", padding: "9px 11px", borderRadius: 8, wordBreak: "break-all" }}
            >
              {created.joinUrl}
            </code>
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="solid" type="button" onClick={copy}>
                {copied ? "Copied ✓" : "Copy link"}
              </Button>
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </div>
            {created.city.created && (
              <p style={{ margin: 0, fontSize: ".76rem", color: "var(--ink-faint)" }}>
                No existing city covered this shop, so {created.city.name} was added and marked as never
                scraped — worth an ingest run if you add more partners there.
              </p>
            )}
          </>
        ) : (
          <>
            <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Add a florist you already work with</h2>

            <Row label={offMaps ? "Find their street address on Google Maps" : "Find the shop on Google Maps"}>
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPlace(null);
                }}
                placeholder="Shop name and city…"
                autoFocus
                style={field}
              />
            </Row>
            {searching && !place && <p style={{ margin: 0, fontSize: ".76rem", color: "var(--ink-faint)" }}>Searching…</p>}
            {/* Plenty of real florists have no Google listing — older shops, ones
                inside a market hall, ones whose listing was never claimed. The
                street they are on is listed even when the business is not, and
                that is all we need: coordinates, without which the matcher can
                never see them. */}
            <button
              type="button"
              className="link-subtle"
              style={{ background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer", fontSize: ".76rem" }}
              onClick={() => { setOffMaps((v) => !v); setPlace(null); setQuery(""); }}
            >
              {offMaps ? "← They are on Google Maps after all" : "Can't find them? They may not be on Maps — enter the details yourself"}
            </button>
            {suggestions.length > 0 && (
              <ul className="ac-list" role="listbox" style={{ position: "static" }}>
                {suggestions.map((s) => (
                  <li key={s.placeId} className="ac-item" role="option" aria-selected={false} onClick={() => void pick(s)}>
                    {s.primary}
                    <span className="ac-secondary">{s.secondary}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* In off-maps mode the fields appear straight away. Gating them on a
                Places pick was the bug: you'd toggle "can't find them", type the
                SHOP name (the natural thing — you were just looking for it),
                get no usable suggestion, and be left with an empty dialog and a
                dead Create button that never said why. */}
            {(place || offMaps) && (
              <>
                {offMaps ? (
                  <>
                    {place ? (
                      <div style={{ background: "var(--surface-2)", borderRadius: 8, padding: "10px 12px", fontSize: ".8rem", lineHeight: 1.5 }}>
                        <b>✓ Location confirmed</b>
                        <div style={{ color: "var(--ink-soft)" }}>{place.address ?? place.name}</div>
                        <div style={{ color: "var(--ink-faint)", marginTop: 4 }}>
                          We only took the coordinates from this — everything else is yours to fill in.
                        </div>
                      </div>
                    ) : (
                      <div style={{ background: "color-mix(in srgb, var(--warn) 8%, var(--surface-2))", borderRadius: 8, padding: "10px 12px", fontSize: ".8rem", lineHeight: 1.5 }}>
                        <b>Still need their location</b>
                        <div style={{ color: "var(--ink-soft)" }}>
                          Search their STREET above and pick it from the list — not the shop name. The shop may be
                          unlisted, but the street is on Maps, and its coordinates are what let orders reach them.
                        </div>
                      </div>
                    )}
                    <Row label="Shop name">
                      <input value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="Fleurs de Marie" style={field} />
                    </Row>
                    <Row label="Shop phone" hint="optional">
                      <input value={manualPhone} onChange={(e) => setManualPhone(e.target.value)} placeholder="+33 5…" style={field} />
                    </Row>
                    <Row label="Website" hint="optional — lets us find their email automatically">
                      <input value={manualSite} onChange={(e) => setManualSite(e.target.value)} placeholder="https://…" style={field} />
                    </Row>
                  </>
                ) : place ? (
                <div style={{ background: "var(--surface-2)", borderRadius: 8, padding: "10px 12px", fontSize: ".8rem", lineHeight: 1.5 }}>
                  <b>{place.name}</b>
                  <div style={{ color: "var(--ink-soft)" }}>{place.address ?? "No address"}</div>
                  <div style={{ color: "var(--ink-soft)" }}>
                    {[place.phone, place.website, place.rating ? `★ ${place.rating} (${place.reviewCount ?? 0})` : null]
                      .filter(Boolean)
                      .join(" · ") || "No phone or website on Maps"}
                  </div>
                  {hoursNote && <div style={{ color: "var(--ink-faint)", marginTop: 4 }}>{hoursNote}</div>}
                </div>
                ) : null}

                {needsCity && (
                  <div style={{ display: "grid", gap: 8 }}>
                    <p style={{ margin: 0, fontSize: ".78rem", color: "var(--warn)" }}>
                      No city we already cover reaches this shop. Name one to file it under.
                    </p>
                    <Row label="Country" hint="two-letter code">
                      <input value={countryCode} onChange={(e) => setCountryCode(e.target.value)} maxLength={2} style={field} />
                    </Row>
                    <Row label="City">
                      <input value={cityName} onChange={(e) => setCityName(e.target.value)} style={field} />
                    </Row>
                  </div>
                )}

                {/* Mobile and email are the two channels an offer goes out on
                    (lib/reachoutSend.ts). One of them is required — a shop we
                    cannot reach never sees an order, however good its record. */}
                <p style={{ margin: "4px 0 -4px", fontSize: ".7rem", textTransform: "uppercase", letterSpacing: ".05em", color: "var(--ink-faint)", fontWeight: 700 }}>
                  So we can reach them — at least one
                </p>
                <Row label="Mobile" hint="the number you text them on">
                  <input value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="+34 6…" style={field} />
                </Row>
                <Row label="Email">
                  <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="hola@shop.com" style={field} />
                </Row>
                <Row label="Contact person" hint="who you talk to">
                  <input value={owner} onChange={(e) => setOwner(e.target.value)} style={field} />
                </Row>

                {/* The matcher's hard filter rejects a florist missing either of
                    these, so without them they would join and then silently
                    receive nothing. */}
                <p style={{ margin: "4px 0 -4px", fontSize: ".7rem", textTransform: "uppercase", letterSpacing: ".05em", color: "var(--ink-faint)", fontWeight: 700 }}>
                  So they can receive orders
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <Row label="Delivery radius" hint="km">
                    <input value={radius} onChange={(e) => setRadius(e.target.value)} inputMode="numeric" style={field} />
                  </Row>
                  <Row label="Trust tier">
                    <select value={tier} onChange={(e) => setTier(e.target.value)} style={field}>
                      {tiers.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </Row>
                </div>
                <Row label="Stage">
                  <select value={stage} onChange={(e) => setStage(e.target.value)} style={field}>
                    {["production", "onboarding", "engaged", "contacted"].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </Row>
                <Row label="How you know them" hint="optional">
                  <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Partner since 2024, we WhatsApp them" style={field} />
                </Row>
              </>
            )}

            {error && (
              <p role="alert" style={{ margin: 0, color: "var(--crit)", fontSize: ".82rem" }}>
                {error}
              </p>
            )}

            {blockedBy && (
              <p style={{ margin: 0, fontSize: ".76rem", color: "var(--ink-faint)", textAlign: "right" }}>{blockedBy}</p>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button type="button" onClick={onClose}>Cancel</Button>
              <Button variant="solid" type="button" disabled={!!blockedBy || submitting} onClick={submit}>
                {submitting ? "…" : confirmDup ? "Add anyway + get link" : "Create + get join link"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
