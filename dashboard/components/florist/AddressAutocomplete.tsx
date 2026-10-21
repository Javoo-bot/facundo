"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

interface Suggestion {
  placeId: string;
  primary: string;
  secondary: string;
}

export interface AddressLabels {
  label: string;
  placeholder: string;
  hint: string;
  verified: string;
  searching: string;
  noResults: string;
}

const DEBOUNCE_MS = 250;
const MIN_CHARS = 3;

/** Google-Places-backed address field for the public join form.
 *
 * The browser never talks to Google — `/api/places/*` proxies with a
 * server-only key, gated on this florist's join token (lib/joinTokenGate.ts).
 *
 * Two behaviours worth knowing about:
 *
 * - SESSION TOKEN. Google bills autocomplete per session, not per keystroke,
 *   but only if one token spans every keystroke AND the final details call.
 *   We mint one lazily, thread it through, and retire it after a pick — so the
 *   next edit starts a fresh session.
 *
 * - VERIFICATION IS NOT STICKY. Picking a suggestion sets coordinates and
 *   shows the verified line; typing afterwards clears both. Keeping
 *   coordinates that no longer match the text on screen would put a shop
 *   wherever the florist's first guess happened to land.
 *
 * Degrades to a plain text input whenever Places isn't configured or the proxy
 * errors — a florist must always be able to type their address. */
export default function AddressAutocomplete({
  token,
  value,
  onChange,
  onPick,
  verified,
  labels,
}: {
  token: string;
  value: string;
  /** Free text — clears any prior verification in the parent. */
  onChange: (address: string) => void;
  /** A verified pick: formatted address plus coordinates. */
  onPick: (place: { address: string; lat: number; lng: number }) => void;
  /** True once the parent holds coordinates for this text. The "pick your shop
   * from the list" hint is an instruction to do something already done, so it
   * yields to the parent's verified line. */
  verified: boolean;
  labels: AddressLabels;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  // Nothing happens until the florist actually edits the field. The address
  // arrives pre-filled from the ingest, and searching for it on mount would
  // spend a billable Places call on every page view AND label a perfectly good
  // stored address "no matches" before they've touched anything.
  const [touched, setTouched] = useState(false);
  // Reported by the proxy. False when GOOGLE_PLACES_API_KEY isn't set — then
  // this is just a text input, and the "pick from the list" hint would be
  // telling the florist to do something impossible.
  const [configured, setConfigured] = useState(true);

  const listId = useId();
  const sessionToken = useRef<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Bumped on every keystroke so a slow response for an older query can't
  // overwrite the suggestions for a newer one.
  const queryId = useRef(0);
  // A value THIS component pushed into the parent, which must not trigger a
  // search when it comes back down as a new `value`. Picking a suggestion sets
  // the text twice (optimistically, then from the details response), and
  // without this each one searches for the address just chosen — reopening the
  // list the pick closed, and paying Google twice more for it.
  const selfSet = useRef<string | null>(null);

  const ensureSession = () => {
    if (!sessionToken.current) sessionToken.current = crypto.randomUUID();
    return sessionToken.current;
  };

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);

  // Click-away. Blur alone doesn't work here — mousedown on a suggestion blurs
  // the input before the click lands.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open, close]);

  useEffect(() => {
    if (!touched) return;
    if (selfSet.current === value) {
      selfSet.current = null;
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length < MIN_CHARS) {
      setSuggestions([]);
      setSearched(false);
      return;
    }
    const id = ++queryId.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/places/autocomplete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, input: trimmed, sessionToken: ensureSession() }),
        });
        if (id !== queryId.current) return; // a newer keystroke won
        const json = res.ok
          ? ((await res.json()) as { suggestions?: Suggestion[]; configured?: boolean })
          : { suggestions: [], configured: true };
        if (json.configured === false) setConfigured(false);
        setSuggestions(json.suggestions ?? []);
        setOpen((json.suggestions ?? []).length > 0);
        setActive(-1);
      } catch {
        if (id === queryId.current) setSuggestions([]);
      } finally {
        if (id === queryId.current) {
          setSearching(false);
          setSearched(true);
        }
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, token, touched]);

  const pick = async (s: Suggestion) => {
    close();
    // Show the picked text immediately — the details round trip shouldn't
    // leave the field looking unchanged.
    const optimistic = s.secondary ? `${s.primary}, ${s.secondary}` : s.primary;
    selfSet.current = optimistic;
    onChange(optimistic);
    // Any in-flight keystroke response is now stale — its results would reopen
    // the list we just closed.
    queryId.current++;
    setSuggestions([]);
    // Also clear the "we searched and found nothing" state. Without this the
    // empty list left behind by the pick reads as a no-match, and the field
    // says "No matches" directly above the address it just verified.
    setSearched(false);
    const session = ensureSession();
    sessionToken.current = null; // this pick closes the billing session
    try {
      const res = await fetch("/api/places/details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, placeId: s.placeId, sessionToken: session }),
      });
      if (!res.ok) return; // typed text stands, just unverified
      const place = (await res.json()) as { address: string; lat: number; lng: number };
      selfSet.current = place.address;
      onPick(place);
    } catch {
      // Same as above: leave the text, skip the verification.
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      void pick(suggestions[active]);
    } else if (e.key === "Escape") {
      close();
    }
  };

  return (
    <div className="ac-wrap" ref={wrapRef}>
      <input
        value={value}
        onChange={(e) => {
          setTouched(true);
          onChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        placeholder={labels.placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        style={{ width: "100%", padding: "10px 12px", fontSize: ".95rem" }}
      />
      {open && suggestions.length > 0 && (
        <ul className="ac-list" id={listId} role="listbox">
          {suggestions.map((s, i) => (
            <li
              key={s.placeId}
              id={`${listId}-${i}`}
              className="ac-item"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()} // keep focus so the click lands
              onClick={() => void pick(s)}
            >
              {s.primary}
              {s.secondary && <span className="ac-secondary">{s.secondary}</span>}
            </li>
          ))}
        </ul>
      )}
      {configured && !verified && (
        <p style={{ fontSize: ".75rem", color: "var(--ink-faint)", margin: "5px 0 0" }}>
          {searching
            ? labels.searching
            : touched && searched && suggestions.length === 0 && value.trim().length >= MIN_CHARS
              ? labels.noResults
              : labels.hint}
        </p>
      )}
    </div>
  );
}
