"use client";

import { useState } from "react";
import { joinPhone, type DialCountry } from "@/lib/dialCodes";

/** A country dropdown plus a national-number box, submitting one E.164 string.
 *
 * The country list arrives as plain data from the server (lib/dialCodes.ts) —
 * libphonenumber-js and i18n-iso-countries never reach the browser, which
 * would otherwise be a few hundred KB to render a <select> of static options.
 *
 * The florist sees "+34" and types "612 34 56 78" instead of having to know
 * that a leading zero comes off and a country code goes on. Pasting a full
 * "+33…" number still works — joinPhone leaves it alone. */
export default function PhoneField({
  countries,
  initialCode,
  initialNational,
  onChange,
  id,
  autoComplete,
  countryLabel,
}: {
  countries: DialCountry[];
  initialCode: string;
  initialNational: string;
  /** The composed value, "" when nothing is typed. */
  onChange: (value: string) => void;
  id: string;
  autoComplete?: string;
  /** Accessible name for the country control — it has no visible label. */
  countryLabel: string;
}) {
  const [code, setCode] = useState(initialCode || (countries[0]?.code ?? ""));
  const [national, setNational] = useState(initialNational);

  const dialFor = (c: string) => countries.find((x) => x.code === c)?.dial ?? "";

  const emit = (nextCode: string, nextNational: string) => {
    setCode(nextCode);
    setNational(nextNational);
    onChange(joinPhone(dialFor(nextCode), nextNational));
  };

  return (
    <div style={{ display: "flex", gap: 6 }}>
      <select
        value={code}
        aria-label={countryLabel}
        onChange={(e) => emit(e.target.value, national)}
        style={{ padding: "10px 6px", fontSize: ".95rem", maxWidth: 132, flex: "0 0 auto" }}
      >
        {countries.map((c) => (
          // The option text carries the country name so the native dropdown
          // stays type-ahead searchable ("spa" jumps to Spain); the closed
          // control is narrow enough that it shows the flag and code.
          <option key={c.code} value={c.code}>
            {c.flag} +{c.dial} {c.name}
          </option>
        ))}
      </select>
      <input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete={autoComplete}
        value={national}
        onChange={(e) => emit(code, e.target.value)}
        style={{ flex: 1, minWidth: 0, padding: "10px 12px", fontSize: ".95rem" }}
      />
    </div>
  );
}
