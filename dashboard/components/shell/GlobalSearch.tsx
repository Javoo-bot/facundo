"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@/lib/supabase";
import { IconSearch } from "@/components/icons";

type Kind = "order" | "florist" | "city";
type Result = { kind: Kind; id: string; title: string; sub: string | null; href: string };

const KIND_LABEL: Record<Kind, string> = { order: "Orders", florist: "Florists", city: "Cities" };
const KIND_ORDER: Kind[] = ["order", "florist", "city"];

/**
 * Global cross-entity search for the staff shell. Reads via the RLS-scoped
 * session client (anon key + JWT), so an allow-listed staff user searches
 * orders (by name/recipient), florists (by name), and cities (by name).
 * Client-side, debounced; scoped to the loaded rows Supabase returns (top N
 * per type) — a real search service is a later concern, but this is genuinely
 * functional, not a stub.
 */
export default function GlobalSearch() {
  const router = useRouter();
  const supabase = useMemo(() => createBrowserClient(), []);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const handle = setTimeout(async () => {
      // Strip characters that would break the PostgREST `or`/`ilike` filter syntax.
      const like = `%${term.replace(/[%,()]/g, "")}%`;
      const [orders, florists, cities] = await Promise.all([
        supabase
          .from("orders")
          .select("id, order_name, recipient_name, delivery_area")
          .or(`order_name.ilike.${like},recipient_name.ilike.${like}`)
          .limit(6),
        supabase.from("florists").select("id, name, address").ilike("name", like).is("deleted_at", null).limit(6),
        supabase.from("cities").select("id, city, country").ilike("city", like).limit(4),
      ]);
      if (cancelled) return;
      const next: Result[] = [];
      for (const o of orders.data ?? [])
        next.push({ kind: "order", id: o.id, title: o.order_name ?? `#${o.id.slice(0, 6)}`, sub: o.recipient_name ?? o.delivery_area ?? null, href: `/orders/${o.id}` });
      for (const f of florists.data ?? [])
        next.push({ kind: "florist", id: f.id, title: f.name, sub: f.address ?? null, href: `/florists/${f.id}` });
      for (const c of cities.data ?? [])
        next.push({ kind: "city", id: c.id, title: c.city, sub: c.country ?? null, href: `/city/${c.id}` });
      setResults(next);
      setActive(-1);
      setLoading(false);
      setOpen(true);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q, supabase]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  function close() {
    setOpen(false);
    setQ("");
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % results.length);
    } else if (e.key === "Enter" && active >= 0 && active < results.length) {
      e.preventDefault();
      const r = results[active];
      close();
      router.push(r.href);
    }
  }

  // Group results by kind while keeping a flat index for keyboard navigation.
  let idx = -1;
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    items: results.filter((r) => r.kind === kind).map((r) => ({ r, i: ++idx })),
  })).filter((g) => g.items.length > 0);

  const showEmpty = !loading && results.length === 0 && q.trim().length >= 2;

  return (
    <div ref={rootRef} className="relative w-full">
      <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => {
          if (results.length || showEmpty) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        placeholder="Search orders, florists, cities…"
        aria-label="Search"
        role="combobox"
        aria-expanded={open}
        aria-controls="global-search-results"
        autoComplete="off"
        className="h-9 w-full rounded-lg border-none bg-surface-2 pl-8 pr-3 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      />
      {open && (results.length > 0 || showEmpty || loading) && (
        <div
          id="global-search-results"
          role="listbox"
          className="absolute left-0 right-0 top-full z-40 mt-1.5 max-h-[70vh] overflow-auto rounded-lg border border-line bg-surface py-1 shadow-card"
        >
          {loading && results.length === 0 && <p className="px-3 py-2 text-xs text-ink-faint">Searching…</p>}
          {showEmpty && <p className="px-3 py-2 text-xs text-ink-faint">No matches for &ldquo;{q.trim()}&rdquo;.</p>}
          {groups.map((g) => (
            <div key={g.kind}>
              <p className="mini-h px-3 pb-1 pt-2">{KIND_LABEL[g.kind]}</p>
              {g.items.map(({ r, i }) => (
                <Link
                  key={`${r.kind}-${r.id}`}
                  href={r.href}
                  role="option"
                  aria-selected={i === active}
                  onClick={close}
                  onMouseEnter={() => setActive(i)}
                  className={`block px-3 py-1.5 text-sm ${i === active ? "bg-surface-2" : "hover:bg-surface-2"}`}
                >
                  <span className="font-medium text-ink">{r.title}</span>
                  {r.sub && <span className="text-ink-soft"> · {r.sub}</span>}
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
