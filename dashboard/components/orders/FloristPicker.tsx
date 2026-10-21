"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { FloristDirectoryEntry } from "@/lib/types";
import Button from "@/components/ui/Button";

const RESULT_LIMIT = 8;
const DEBOUNCE_MS = 250;

// "Add any florist" — searches the directory on demand (rather than filtering
// a full roster fetched up front — see /api/florists/options's header for why
// that used to be an eager multi-thousand-row load) and attaches a chosen
// florist to the order (candidate, or queued+ready-to-send when "Offer").
// Bypasses the onboarded match filter by design; flags non-onboarded picks.
export default function FloristPicker({
  orderId,
  assignedIds,
}: {
  orderId: string;
  assignedIds: Set<string>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<FloristDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Which result row the combobox's keyboard focus is on — -1 means none
  // (empty results, or nothing pickable in the list yet).
  const [activeIndex, setActiveIndex] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);
  const listboxId = "florist-picker-listbox";

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setSearchErr(null);
      fetch(`/api/florists/options?detail=1&withEmail=0&includeExcluded=1&limit=${RESULT_LIMIT}&q=${encodeURIComponent(q.trim())}`, {
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Search failed.");
          return res.json();
        })
        .then((data) => {
          setResults(data.florists ?? []);
          setActiveIndex(0);
          setLoading(false);
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return; // superseded by a newer keystroke
          setSearchErr(e instanceof Error ? e.message : "Search failed.");
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, q]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // A row is pickable (via click or the keyboard) only once it's neither
  // denylisted nor already on this order — same gate the buttons already used.
  function pickable(f: FloristDirectoryEntry): boolean {
    return !f.excluded_at && !assignedIds.has(f.id);
  }

  async function add(floristId: string, offer: boolean) {
    setBusy(floristId + (offer ? "-offer" : "-add"));
    setErr(null);
    try {
      const res = await fetch("/api/orders/assign", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, floristId, offer }),
      });
      if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? "Failed to add florist."); return; }
      setOpen(false); setQ(""); setResults([]); setActiveIndex(-1);
      router.refresh();
    } finally { setBusy(null); }
  }

  // Combobox keyboard support: Up/Down move the highlighted row (skipping
  // rows that can't be picked), Enter adds the highlighted florist (the same
  // action as clicking "Add" — never a raw-text submit), Escape closes.
  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) {
      if (e.key === "Escape") { setOpen(false); setQ(""); setResults([]); setErr(null); }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((prev) => {
        let next = prev;
        for (let step = 0; step < results.length; step++) {
          next = (next + dir + results.length) % results.length;
          if (pickable(results[next])) break;
        }
        return next;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = results[activeIndex];
      if (target && pickable(target) && busy === null) void add(target.id, false);
    } else if (e.key === "Escape") {
      setOpen(false); setQ(""); setResults([]); setErr(null);
    }
  }

  if (!open) {
    return <Button variant="default" onClick={() => setOpen(true)}>+ Add florist</Button>;
  }

  return (
    <div style={{ border: "1px solid var(--line-strong)", borderRadius: 10, padding: 10, background: "var(--surface)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <label htmlFor="florist-picker-search" className="sr-only">
          Search and pick a florist to add to this order
        </label>
        <input
          id="florist-picker-search"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search florists by name…"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 && results[activeIndex] ? `florist-picker-option-${results[activeIndex].id}` : undefined}
          style={{ flex: 1, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--line-strong)", background: "var(--surface)", color: "var(--ink)", fontSize: ".85rem" }}
        />
        <button type="button" className="btn btn-ghost" onClick={() => { setOpen(false); setQ(""); setResults([]); setErr(null); }}>Close</button>
      </div>
      {err && <div style={{ color: "var(--crit)", fontSize: ".8rem", marginBottom: 6 }}>{err}</div>}
      {searchErr && <div style={{ color: "var(--crit)", fontSize: ".8rem", marginBottom: 6 }}>{searchErr}</div>}
      <div
        id={listboxId}
        role="listbox"
        aria-label="Florist search results"
        style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 260, overflowY: "auto" }}
      >
        {loading && <div style={{ color: "var(--ink-faint)", fontSize: ".85rem", padding: 6 }}>Searching…</div>}
        {!loading && !searchErr && results.length === 0 && (
          <div style={{ color: "var(--ink-faint)", fontSize: ".85rem", padding: 6 }}>
            {q.trim() ? "No florists match." : "Start typing to search florists."}
          </div>
        )}
        {!loading && results.map((f, i) => {
          const already = assignedIds.has(f.id);
          const excluded = !!f.excluded_at;
          const onboarded = f.lifecycle_stage === "production" || f.lifecycle_stage === "onboarding";
          const active = i === activeIndex;
          return (
            <div
              key={f.id}
              id={`florist-picker-option-${f.id}`}
              role="option"
              aria-selected={active}
              onMouseEnter={() => setActiveIndex(i)}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 4px",
                borderBottom: "1px solid var(--line)", opacity: excluded ? 0.6 : 1,
                borderRadius: 6,
                background: active ? "var(--surface-2)" : undefined,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: ".85rem" }}>{f.name}</div>
                <div style={{ fontSize: ".72rem", color: "var(--ink-faint)" }}>
                  {f.address ?? "—"} · {f.lifecycle_stage ?? "—"}
                  {excluded && <span style={{ color: "var(--crit)" }}> · excluded</span>}
                  {!excluded && !onboarded && <span style={{ color: "var(--warn)" }}> · not onboarded</span>}
                </div>
              </div>
              {excluded ? (
                <span className="badge badge-crit">Denylisted</span>
              ) : already ? (
                <span className="badge badge-neutral">On order</span>
              ) : (
                <>
                  <Button variant="default" disabled={busy !== null} onClick={() => add(f.id, false)}>Add</Button>
                  <Button variant="solid" disabled={busy !== null} onClick={() => add(f.id, true)}>Offer</Button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
