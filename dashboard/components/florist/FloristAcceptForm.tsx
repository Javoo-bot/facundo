"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import AddressAutocomplete, { type AddressLabels } from "@/components/florist/AddressAutocomplete";
import OpeningHours, { type HoursLabels } from "@/components/florist/OpeningHours";
import PhoneField from "@/components/florist/PhoneField";
import { joinPhone, type DialCountry } from "@/lib/dialCodes";
import { CUTOFF_HOURS, OWNER_NAME_MAX, SHOP_STORY_MAX } from "@/lib/floristAccept";
import { toDayRows, toBusinessHours, invalidRows, type DayRow } from "@/lib/businessHours";

export interface AcceptFormLabels {
  localeLabel: string;
  labelOwner: string;
  labelName: string;
  labelPhone: string;
  labelMobile: string;
  mobileHelper: string;
  mobileInvalid: string;
  optional: string;
  countryLabel: string;
  labelEmail: string;
  storyTitle: string;
  storyHelper: string;
  storyPlaceholder: string;
  cutoffTitle: string;
  cutoffHelper: string;
  submit: string;
  error: string;
  hoursInvalid: string;
  alreadyBody: string;
  address: AddressLabels;
  hours: HoursLabels;
}

function Field({
  label,
  optional,
  children,
}: {
  label: string;
  /** The "(optional)" suffix, when the field is. Rendered in the label's own
   * weight-400 so it reads as an aside rather than part of the field name —
   * matching how the mobile field marks itself below. */
  optional?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: ".85rem", fontWeight: 600 }}>
      <span>
        {label}
        {optional && <span style={{ fontWeight: 400, color: "var(--ink-faint)" }}> {optional}</span>}
      </span>
      {children}
    </label>
  );
}

const inputStyle = { width: "100%", padding: "10px 12px", fontSize: ".95rem", fontWeight: 400 } as const;

export default function FloristAcceptForm({
  token,
  initial,
  countries,
  locale,
  localeOptions,
  labels,
}: {
  token: string;
  /** The language this page is currently rendered in. */
  locale: string;
  /** Every language we support, named in its own language. */
  localeOptions: { code: string; label: string }[];
  initial: {
    name: string;
    owner_name: string;
    /** Pre-split into a country and the rest — see lib/dialCodes.ts::splitPhone. */
    phone: { code: string; national: string };
    mobile: { code: string; national: string };
    address: string;
    email: string;
    shop_story: string;
    business_hours: Record<string, unknown> | null;
    next_day_cutoff_hour: number | null;
  };
  /** Built server-side so libphonenumber never ships to the browser. */
  countries: DialCountry[];
  labels: AcceptFormLabels;
}) {
  const [name, setName] = useState(initial.name);
  const [ownerName, setOwnerName] = useState(initial.owner_name);
  const [address, setAddress] = useState(initial.address);
  // Coordinates only exist once a Google Places suggestion is picked. Null
  // means "typed by hand", which the server treats as "leave the stored
  // coordinates alone" (lib/floristAccept.ts::buildAcceptUpdate).
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  // PhoneField owns the country/national split; these hold only the composed
  // E.164 string it emits, which is what the server wants. Seeded from the
  // same split, because PhoneField only calls back once the florist edits —
  // without this, an untouched pre-filled phone would submit as empty.
  const dialOf = (code: string) => countries.find((c) => c.code === code)?.dial ?? "";
  const [phone, setPhone] = useState(() => joinPhone(dialOf(initial.phone.code), initial.phone.national));
  const [mobile, setMobile] = useState(() => joinPhone(dialOf(initial.mobile.code), initial.mobile.national));
  const [email, setEmail] = useState(initial.email);
  const [story, setStory] = useState(initial.shop_story);
  const [rows, setRows] = useState<DayRow[]>(() => toDayRows(initial.business_hours));
  const [cutoff, setCutoff] = useState<number>(initial.next_day_cutoff_hour ?? 13);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setError(null);

    // Client-side guard for the one validation failure a florist can hit
    // without the server's help. The server enforces this and everything else;
    // this just avoids a round trip, and shows a localized message — we can't
    // translate the server's English validation strings.
    //
    // The mobile is NOT checked here: it's optional, and whether a given
    // number is textable is a libphonenumber question we deliberately keep on
    // the server rather than shipping the library to the browser. A bad one
    // comes back as a 400 and is mapped to `mobileInvalid` below.
    if (invalidRows(rows).length > 0) {
      setError(labels.hoursInvalid);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/florist/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          locale,
          name,
          owner_name: ownerName,
          address,
          phone,
          phone_mobile: mobile,
          email,
          shop_story: story,
          business_hours: toBusinessHours(rows),
          next_day_cutoff_hour: cutoff,
          lat: coords?.lat ?? null,
          lng: coords?.lng ?? null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}) as { error?: string });
        // The server's validation strings are English-only. Map the one a
        // florist can realistically trigger back to localized copy; anything
        // else falls through to the generic message rather than showing them
        // a sentence in a language they may not read.
        setError(j.error?.includes("phone_mobile") ? labels.mobileInvalid : labels.error);
        return;
      }
      // Onboarding ends INSIDE the signed-in app, not on a "thanks" card: the
      // server hands back a one-click sign-in link for the florist who just
      // redeemed this join token. `location.assign` (not the router) because
      // the target is a route handler that must set session cookies.
      const j = (await res.json().catch(() => ({}))) as { signInUrl?: string | null };
      if (j.signInUrl) {
        location.assign(j.signInUrl);
        return;
      }
      setDone(true);
    } catch {
      setError(labels.error);
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return <p style={{ color: "var(--accent)", fontSize: ".95rem" }}>{labels.alreadyBody}</p>;
  }

  const storyLeft = SHOP_STORY_MAX - story.length;

  // Switching language re-requests the page: every string on it is resolved
  // server-side, so there is nothing to re-render on the client. The choice
  // rides along in the submission and only then becomes their stored setting.
  const switchLocale = (next: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("locale", next);
    window.location.assign(url.toString());
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, textAlign: "left" }}>
      <label style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, fontSize: ".78rem", color: "var(--ink-soft)" }}>
        {labels.localeLabel}
        <select
          value={locale}
          onChange={(e) => switchLocale(e.target.value)}
          style={{ padding: "6px 8px", fontSize: ".82rem" }}
        >
          {localeOptions.map((o) => (
            <option key={o.code} value={o.code}>{o.label}</option>
          ))}
        </select>
      </label>

      {/* Who we're talking to, before what the shop is called. It seeds the
          "Good evening, Marta" greeting on this very page and every message we
          send afterwards — the column already existed and was populated by the
          ingest, we simply never asked the florist to confirm it. Optional:
          this is the first field on a form whose whole job is getting signed,
          and a name is not worth a validation error. */}
      <Field label={labels.labelOwner} optional={labels.optional}>
        <input
          value={ownerName}
          onChange={(e) => setOwnerName(e.target.value.slice(0, OWNER_NAME_MAX))}
          maxLength={OWNER_NAME_MAX}
          autoComplete="name"
          style={inputStyle}
        />
      </Field>

      <Field label={labels.labelName}>
        <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
      </Field>

      <div>
        <p style={{ fontSize: ".85rem", fontWeight: 600, margin: "0 0 5px" }}>{labels.address.label}</p>
        <AddressAutocomplete
          token={token}
          value={address}
          onChange={(v) => {
            setAddress(v);
            setCoords(null); // typed text is no longer the verified place
          }}
          onPick={(place) => {
            setAddress(place.address);
            setCoords({ lat: place.lat, lng: place.lng });
          }}
          verified={coords !== null}
          labels={labels.address}
        />
        {coords && (
          <p style={{ fontSize: ".76rem", color: "var(--accent)", margin: "4px 0 0", fontWeight: 600 }}>
            ✓ {labels.address.verified}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="fc-mobile"
          style={{ display: "block", fontSize: ".85rem", fontWeight: 600, marginBottom: 5 }}
        >
          {labels.labelMobile} <span style={{ fontWeight: 400, color: "var(--ink-faint)" }}>{labels.optional}</span>
        </label>
        <PhoneField
          id="fc-mobile"
          countries={countries}
          initialCode={initial.mobile.code}
          initialNational={initial.mobile.national}
          onChange={setMobile}
          autoComplete="tel"
          countryLabel={labels.countryLabel}
        />
        <p style={{ fontSize: ".76rem", color: "var(--ink-soft)", margin: "5px 0 0" }}>{labels.mobileHelper}</p>
      </div>

      <div>
        <label
          htmlFor="fc-phone"
          style={{ display: "block", fontSize: ".85rem", fontWeight: 600, marginBottom: 5 }}
        >
          {labels.labelPhone}
        </label>
        <PhoneField
          id="fc-phone"
          countries={countries}
          initialCode={initial.phone.code}
          initialNational={initial.phone.national}
          onChange={setPhone}
          countryLabel={labels.countryLabel}
        />
      </div>

      <Field label={labels.labelEmail}>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" style={inputStyle} />
      </Field>

      <div style={{ borderTop: "1px dashed var(--line-strong)", paddingTop: 16 }}>
        <OpeningHours rows={rows} setRows={setRows} labels={labels.hours} />
      </div>

      <div style={{ borderTop: "1px dashed var(--line-strong)", paddingTop: 16 }}>
        <p style={{ fontWeight: 600, fontSize: ".95rem", marginBottom: 4 }}>{labels.cutoffTitle}</p>
        <p style={{ fontSize: ".78rem", color: "var(--ink-soft)", marginBottom: 8 }}>{labels.cutoffHelper}</p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {CUTOFF_HOURS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setCutoff(h)}
              aria-pressed={h === cutoff}
              className={h === cutoff ? "btn btn-solid" : "btn"}
            >
              {String(h).padStart(2, "0")}:00
            </button>
          ))}
        </div>
      </div>

      <div style={{ borderTop: "1px dashed var(--line-strong)", paddingTop: 16 }}>
        <p style={{ fontWeight: 600, fontSize: ".95rem", marginBottom: 4 }}>{labels.storyTitle}</p>
        <p style={{ fontSize: ".78rem", color: "var(--ink-soft)", marginBottom: 8 }}>{labels.storyHelper}</p>
        <textarea
          value={story}
          onChange={(e) => setStory(e.target.value.slice(0, SHOP_STORY_MAX))}
          rows={5}
          maxLength={SHOP_STORY_MAX}
          placeholder={labels.storyPlaceholder}
          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.45 }}
        />
        {/* Only once it's close enough to matter — a counter from character
            one reads as a limit to worry about rather than room to write in. */}
        {storyLeft <= 200 && (
          <p style={{ fontSize: ".72rem", color: "var(--ink-faint)", textAlign: "right", margin: "3px 0 0" }}>
            {storyLeft}
          </p>
        )}
      </div>

      {error && (
        <p role="alert" style={{ color: "var(--crit)", fontSize: ".85rem", margin: 0 }}>
          {error}
        </p>
      )}

      <Button variant="solid" className="btn-lg btn-block" type="button" disabled={submitting} onClick={submit}>
        {submitting ? "…" : labels.submit}
      </Button>
    </div>
  );
}
