"use client";

import { useCallback, useEffect, useState } from "react";
import { LOCALES } from "@/lib/i18n";
import { renderSignature, type Persona } from "@/lib/personas";
import { Hint } from "@/components/settings/fields";

/**
 * Settings → Personas. The named humans the outreach funnel's follow-ups come
 * from — one active persona per market.
 *
 * Self-contained (fetches and writes its own rows through /api/personas)
 * rather than threading a dozen props through SettingsClient, and like the
 * Access tab its edits apply immediately — so the shared Save button is hidden
 * here and nothing implies these changes are pending.
 */

const BLANK = {
  locale: "en",
  name: "",
  role_title: "",
  reply_to: "",
  signature_note: "",
};

type Draft = typeof BLANK;

function toDraft(p: Persona): Draft {
  return {
    locale: p.locale,
    name: p.name,
    role_title: p.role_title,
    reply_to: p.reply_to,
    signature_note: p.signature_note ?? "",
  };
}

export default function PersonasPanel() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/personas");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Failed to load (${res.status}).`);
      setPersonas(json.personas as Persona[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load personas.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const editing = editingId !== null;
      const res = await fetch("/api/personas", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { ...draft, id: editingId } : draft),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Failed to save (${res.status}).`);
      setDraft(BLANK);
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save persona.");
    } finally {
      setBusy(false);
    }
  }

  async function setActive(id: string, active: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/personas", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, active }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Failed to update (${res.status}).`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update persona.");
    } finally {
      setBusy(false);
    }
  }

  const active = personas.filter((p) => p.active);
  const retired = personas.filter((p) => !p.active);
  const missing = LOCALES.filter((l) => !active.some((p) => p.locale === l));

  return (
    <section>
      <h3 className="text-sm font-semibold text-ink">Outreach personas</h3>
      <p className="mt-1 text-sm text-ink-soft">
        The named person every follow-up email comes from. The first email is from Facundo; everything
        after it is signed by the persona for that market, and replies go to their address. Changes here
        apply immediately, not with the Save button.
      </p>

      {error && (
        <p className="mt-3 rounded-md border border-crit px-3 py-2 text-sm text-crit">{error}</p>
      )}

      {missing.length > 0 && !loading && (
        <Hint>
          No active persona for: {missing.join(", ")}. Those markets fall back to the English persona&apos;s
          name and reply address, which reads oddly in a fluent local-language email.
        </Hint>
      )}

      <div className="mt-4 rounded-md border border-line">
        {loading ? (
          <p className="px-3 py-3 text-sm text-ink-soft">Loading…</p>
        ) : active.length === 0 ? (
          <p className="px-3 py-3 text-sm text-ink-soft">
            No personas yet. Until one exists, follow-up touches have nobody to come from and are skipped.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {active.map((p) => (
              <li key={p.id} className="px-3 py-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs font-medium uppercase text-ink-soft">
                      {p.locale}
                    </span>{" "}
                    <span className="font-medium text-ink">{p.name}</span>
                    <span className="text-ink-soft"> · {p.role_title}</span>
                    <p className="truncate text-xs text-ink-faint">{p.reply_to}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(p.id);
                        setDraft(toDraft(p));
                      }}
                      className="rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void setActive(p.id, false)}
                      className="rounded-md border border-crit px-2.5 py-1 text-xs font-medium text-crit hover:bg-surface-2 disabled:opacity-50"
                    >
                      Retire
                    </button>
                  </div>
                </div>
                <pre className="mt-2 whitespace-pre-wrap rounded bg-surface-2 px-2 py-1.5 text-xs text-ink-soft">
                  {renderSignature(p)}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </div>

      {retired.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-ink-faint">
            {retired.length} retired {retired.length === 1 ? "persona" : "personas"}
          </summary>
          <ul className="mt-2 divide-y divide-line rounded-md border border-line">
            {retired.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="truncate text-ink-soft">
                  {p.locale} · {p.name} · {p.reply_to}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void setActive(p.id, true)}
                  className="shrink-0 rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
          <Hint>
            Retired personas are kept, not deleted — past conversations are attributed to whoever actually
            sent them.
          </Hint>
        </details>
      )}

      <div className="mt-5 rounded-md border border-line p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
          {editingId ? "Edit persona" : "Add a persona"}
        </h4>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="text-ink-soft">Market</span>
            <select
              value={draft.locale}
              onChange={(e) => setDraft({ ...draft, locale: e.target.value })}
              className="mt-1 w-full rounded-md border border-line-strong px-2 py-1.5 text-sm"
            >
              {LOCALES.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="text-ink-soft">Name</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Marta Ruiz"
              className="mt-1 w-full rounded-md border border-line-strong px-3 py-1.5 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="text-ink-soft">Role title</span>
            <input
              value={draft.role_title}
              onChange={(e) => setDraft({ ...draft, role_title: e.target.value })}
              placeholder="Onboarding Manager"
              className="mt-1 w-full rounded-md border border-line-strong px-3 py-1.5 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="text-ink-soft">Reply-to address</span>
            <input
              type="email"
              value={draft.reply_to}
              onChange={(e) => setDraft({ ...draft, reply_to: e.target.value })}
              placeholder="persona@reply.fc.example.net"
              className="mt-1 w-full rounded-md border border-line-strong px-3 py-1.5 text-sm"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="text-ink-soft">Signature note (optional)</span>
            <input
              value={draft.signature_note}
              onChange={(e) => setDraft({ ...draft, signature_note: e.target.value })}
              placeholder="I read every reply myself."
              className="mt-1 w-full rounded-md border border-line-strong px-3 py-1.5 text-sm"
            />
          </label>
        </div>
        <Hint>
          The reply-to address must be one a person actually reads. The follow-ups ask for a reply, so an
          address that bounces turns every interested florist into a dead end.
        </Hint>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || draft.name.trim() === "" || draft.reply_to.trim() === ""}
            className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : editingId ? "Save changes" : "Add persona"}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setDraft(BLANK);
              }}
              disabled={busy}
              className="rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
