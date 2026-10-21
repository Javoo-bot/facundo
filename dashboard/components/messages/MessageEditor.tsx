"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Bold, Copy, Italic, Link2, Plus, RemoveFormatting, Trash2, Underline } from "lucide-react";
import type { Locale } from "@/lib/i18n";
import { parseBlocks, serializeBlocks } from "@/lib/messages/blocks";
import type { Block } from "@/lib/messages/blocks";

interface MessageSummary {
  id: string;
  label: string;
  note: string;
  channel: "email" | "sms";
  audience: "florist" | "customer" | "staff";
  localized: boolean;
}

interface PreviewResult {
  id: string;
  label: string;
  note: string;
  channel: "email" | "sms";
  locale: Locale;
  subject: string;
  html: string;
  text: string;
  keys: string[];
  /** Which of `keys` produced the subject — see the preview route. */
  subjectKeys: string[];
  values: Record<string, string | null>;
  /** What each key actually says today — the override, or the built-in. */
  defaults: Record<string, string>;
  segments: number | null;
  warnings: { key: string | null; message: string }[];
  variables: { name: string; example: string; what: string }[];
}

// The offer email's fixed body can be replaced wholesale by a JSON blocks
// override under this one catalog key (lib/messages/blocks.ts, wired into
// lib/offerEmailContent.ts). Both the full and repeat-florist variants read
// the SAME key, so segment editing is offered for either.
const BLOCKS_KEY = "email.offer.blocks";
const BLOCKS_ELIGIBLE_IDS = new Set(["offer.full", "offer.short"]);

// The preview runs inside a sandboxed iframe: email HTML carries its own
// <table> layout and inline styles, and letting that touch the console's
// stylesheet (or vice versa) would make the preview a lie. This script is
// injected alongside it so the tagged blocks can be edited in place and a
// click tells the parent which field to focus.
const PREVIEW_BRIDGE = `
<style>
  [data-fc-key]{outline:1px dashed rgba(31,122,85,.35);outline-offset:2px;border-radius:2px}
  [data-fc-key]:hover{background:rgba(31,122,85,.10);outline-style:solid}
  [data-fc-key].fc-active{background:rgba(31,122,85,.18);outline:2px solid #1F7A55}
  [data-fc-key][data-fc-editable="1"]{cursor:text}
  [data-fc-key][data-fc-editable="1"]:focus{outline:2px solid #1F7A55;background:rgba(31,122,85,.10)}
</style>
<script>
  // Mark every LEAF tagged span (one with no nested data-fc-key of its own)
  // as directly editable. A wrapper span whose text was built by interpolating
  // one catalog string into another stays click-to-focus only: a keystroke
  // inside it couldn't be attributed to a single key.
  document.querySelectorAll('[data-fc-key]').forEach(function (el) {
    if (!el.querySelector('[data-fc-key]')) {
      el.setAttribute('data-fc-editable', '1');
      el.contentEditable = 'true';
      el.spellcheck = false;
      el.setAttribute('role', 'textbox');
      el.setAttribute('aria-multiline', 'true');
    }
  });

  function editableAncestor(node) {
    var el = node && node.closest ? node.closest('[data-fc-key]') : null;
    return el && el.getAttribute('data-fc-editable') === '1' ? el : null;
  }

  var lastFocused = null;

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-fc-key]') : null;
    if (!el) return;
    if (el.getAttribute('data-fc-editable') === '1') {
      // Editable: let the native click place the caret. Only stop an actual
      // link inside the field from navigating away mid-edit.
      var a = e.target.closest ? e.target.closest('a') : null;
      if (a) e.preventDefault();
      return;
    }
    // A non-leaf wrapper: hand off to the matching field in the side panel,
    // same as before this change.
    e.preventDefault();
    document.querySelectorAll('[data-fc-key].fc-active').forEach(function (n) { n.classList.remove('fc-active'); });
    el.classList.add('fc-active');
    parent.postMessage({ source: 'fc-preview', type: 'click', key: el.getAttribute('data-fc-key') }, '*');
  }, true);

  document.addEventListener('focusin', function (e) {
    var el = editableAncestor(e.target);
    if (!el) return;
    lastFocused = el;
    document.querySelectorAll('[data-fc-key].fc-active').forEach(function (n) { n.classList.remove('fc-active'); });
    el.classList.add('fc-active');
    parent.postMessage({ source: 'fc-preview', type: 'focus', key: el.getAttribute('data-fc-key') }, '*');
  });

  document.addEventListener('focusout', function (e) {
    var el = editableAncestor(e.target);
    if (!el) return;
    parent.postMessage({ source: 'fc-preview', type: 'blur', key: el.getAttribute('data-fc-key'), html: el.innerHTML }, '*');
  });

  document.addEventListener('input', function (e) {
    var el = editableAncestor(e.target);
    if (!el) return;
    parent.postMessage({ source: 'fc-preview', type: 'input', key: el.getAttribute('data-fc-key'), html: el.innerHTML }, '*');
  });

  // The formatting toolbar lives in the parent document (outside the sandbox)
  // and drives THIS document's own execCommand over postMessage: a sandboxed
  // srcDoc iframe with no allow-same-origin can't be reached synchronously
  // from the parent at all. document.execCommand is deprecated, but it is
  // still the only thing that reliably drives bold/italic/underline/link in a
  // contentEditable region without pulling in a rich-text-editor dependency.
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.source !== 'fc-editor' || e.data.type !== 'exec') return;
    if (!lastFocused) return;
    lastFocused.focus();
    document.execCommand(e.data.cmd, false, e.data.value);
    parent.postMessage({ source: 'fc-preview', type: 'input', key: lastFocused.getAttribute('data-fc-key'), html: lastFocused.innerHTML }, '*');
  });
<\/script>`;

const toolbarBtnStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 24, height: 24, borderRadius: 6, border: "1px solid var(--line-strong)",
  background: "var(--surface)", color: "var(--ink-soft)", cursor: "pointer",
};

/** Bold / italic / underline / link / clear-formatting, shared by the iframe's
 * floating toolbar and each body-segment field. `onCommand` is the only seam:
 * the iframe version posts it into the sandboxed document, the segment
 * version runs it on a local contentEditable directly. */
function FormatButtons({ onCommand, note }: { onCommand: (cmd: string, value?: string) => void; note?: string }) {
  const buttons: { cmd: string; label: string; Icon: typeof Bold }[] = [
    { cmd: "bold", label: "Bold", Icon: Bold },
    { cmd: "italic", label: "Italic", Icon: Italic },
    { cmd: "underline", label: "Underline", Icon: Underline },
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
      {buttons.map(({ cmd, label, Icon }) => (
        <button
          key={cmd}
          type="button"
          title={label}
          aria-label={label}
          // A normal mousedown would shift focus to this button first, which
          // collapses the text selection the command is supposed to apply to.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onCommand(cmd)}
          style={toolbarBtnStyle}
        >
          <Icon size={13} />
        </button>
      ))}
      <button
        type="button"
        title="Link"
        aria-label="Link"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const url = window.prompt("Link URL (https://...)");
          if (url) onCommand("createLink", url);
        }}
        style={toolbarBtnStyle}
      >
        <Link2 size={13} />
      </button>
      <button
        type="button"
        title="Clear formatting"
        aria-label="Clear formatting"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onCommand("removeFormat")}
        style={toolbarBtnStyle}
      >
        <RemoveFormatting size={13} />
      </button>
      {note && <span style={{ fontSize: ".68rem", color: "var(--crit)", flexBasis: "100%" }}>{note}</span>}
    </div>
  );
}

/** One rich-text field for a body segment (a paragraph/heading's html, or one
 * numbered step). Uncontrolled by design: React never re-renders this node's
 * children from `html` while it has focus, or every keystroke would relocate
 * the caret to the start. `onChange` fires on every input (drives the live
 * preview); `onCommit` fires on blur (drives the actual draft save), matching
 * the same change/blur split every other field in this editor already uses. */
function SegmentField({
  html,
  onChange,
  onCommit,
  ariaLabel,
}: {
  html: string;
  onChange: (html: string) => void;
  onCommit: (html: string) => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const lastPushed = useRef<string>("");

  useLayoutEffect(() => {
    if (focused) return;
    if (ref.current && html !== lastPushed.current) {
      ref.current.innerHTML = html;
      lastPushed.current = html;
    }
  }, [html, focused]);

  function runCommand(cmd: string, value?: string) {
    ref.current?.focus();
    document.execCommand(cmd, false, value); // see the iframe bridge above for why execCommand
    const next = ref.current?.innerHTML ?? "";
    lastPushed.current = next;
    onChange(next);
  }

  return (
    <div>
      {focused && <FormatButtons onCommand={runCommand} />}
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onCommit(ref.current?.innerHTML ?? "");
        }}
        onInput={() => {
          const next = ref.current?.innerHTML ?? "";
          lastPushed.current = next;
          onChange(next);
        }}
        style={{
          minHeight: 30, fontSize: ".8rem", lineHeight: 1.45, padding: "6px 8px",
          border: "1px solid " + (focused ? "var(--accent)" : "var(--line-strong)"),
          borderRadius: 8, background: "var(--surface-2)", color: "var(--ink)", whiteSpace: "pre-wrap",
        }}
      />
    </div>
  );
}

/** Restricting and renaming the list, for /flows.
 *
 * /flows shows the SAME editor over a subset of the catalog, under names its
 * audience uses. It is the same component rather than a second one on purpose:
 * two editors over one draft table is two ways for the wrong words to reach a
 * florist, and the click-to-edit-in-the-preview interaction is the part that
 * took the work. */
export interface MessageEditorScope {
  /** Ids to show, in this order. Omitted = the whole catalog. */
  only?: string[];
  /** Friendlier name + one line, per id. Falls back to the registry's own. */
  labels?: Record<string, { label: string; note?: string }>;
  /** Hide the raw catalog-key panel and the per-key translate buttons.
   *  Nobody outside the team knows what `shell.footer` or `t2.greeting` is;
   *  in simple mode you edit the message by typing in the message. */
  simple?: boolean;
  /** Per-row state for the list: which messages are switched off, and which
   *  can be. Only funnel touches can — switching off an order's offer email
   *  would stop orders, so those rows get no tick at all rather than one that
   *  refuses. */
  rowState?: Record<string, { off: boolean; canToggle: boolean; canDuplicate?: boolean; isCopy?: boolean }>;
  /** Called when a row's tick is clicked. Owned by the caller, because what
   *  "off" means (a sequence step the engine skips) is /flows' business. */
  onToggleRow?: (messageId: string, next: boolean) => void | Promise<void>;
  /** Duplicate this message: a real extra send, below it in the funnel.
   *  Absent = the row cannot be duplicated. */
  onDuplicateRow?: (messageId: string) => void | Promise<void>;
  /** Delete a DUPLICATE. Never offered on a built-in message — the code sends
   *  those, so the tick above is what stops them. */
  onDeleteRow?: (messageId: string) => void | Promise<void>;
  /** Drag a DUPLICATE to sit after another row. Built-in rows never move —
   *  their order is the funnel's shape, which is code. */
  onReorderRow?: (messageId: string, afterMessageId: string) => void | Promise<void>;
  /** email id -> its text-message twin. The twin is NOT a list row: the same
   *  message on another channel is one thing to a person, so it lives behind
   *  one Email/Text switch inside the message instead of doubling the list. */
  siblings?: Record<string, string>;
}

/** The small icon buttons on a selected list row. */
const rowActionStyle: React.CSSProperties = {
  flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 22, height: 22, borderRadius: 6, cursor: "pointer",
  border: "1px solid var(--line-strong)", background: "var(--surface)", color: "var(--ink-soft)",
};

export default function MessageEditor({ locales, scope }: { locales: Locale[]; scope?: MessageEditorScope }) {
  const only = scope?.only;
  const simple = scope?.simple ?? false;
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [messageId, setMessageId] = useState<string>(only?.[0] ?? "offer.full");
  const [testing, setTesting] = useState(false);
  /** The duplicate being dragged, and the row it is hovering over. Native
   *  HTML5 drag — no library for one draggable row type. */
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>("en");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [draftCount, setDraftCount] = useState(0);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const fieldRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [translating, setTranslating] = useState<string | null>(null);

  // Inline editing inside the preview iframe.
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeFocused, setIframeFocused] = useState(false);
  const [iframeFocusKey, setIframeFocusKey] = useState<string | null>(null);
  const lastIframeHtml = useRef<Record<string, string>>({});

  const current = useMemo(() => messages.find((m) => m.id === messageId), [messages, messageId]);
  const effectiveLocale: Locale = current && !current.localized ? "en" : locale;
  const blocksSupported = BLOCKS_ELIGIBLE_IDS.has(messageId);

  // --- load the message list once ---
  useEffect(() => {
    fetch("/api/messages/preview")
      .then((r) => r.json())
      .then((d) => {
        const all: MessageSummary[] = d.messages ?? [];
        // `only` is an ORDER as well as a filter: /flows lists a funnel's
        // messages in the sequence they are sent, which the catalog's own
        // order does not know about.
        //
        // An id with no entry in `all` is a DUPLICATE. Duplicates are created
        // at runtime, so the static registry this endpoint returns cannot know
        // about them — before this, `find` returned undefined and the new copy
        // was silently filtered out of the list, which is what made pressing
        // Duplicate look like it did nothing.
        const picked: MessageSummary[] = only
          ? only.map(
              (id) =>
                all.find((m) => m.id === id) ?? {
                  id,
                  label: id,
                  note: "",
                  channel: "email" as const,
                  audience: "florist" as const,
                  localized: true,
                }
            )
          : all;
        setMessages(
          picked.map((m) => {
            const over = scope?.labels?.[m.id];
            return over ? { ...m, label: over.label, note: over.note ?? m.note } : m;
          })
        );
      })
      .catch(() => setStatus("Couldn't load the message list."));
    // Re-runs when the funnel's message list changes — which is exactly what
    // duplicating or deleting one does. Keyed on the joined ids rather than the
    // array, which is a new object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [only?.join("|")]);

  // --- load this locale's saved drafts whenever the locale changes ---
  const loadDrafts = useCallback(async (l: Locale) => {
    try {
      const r = await fetch(`/api/messages/drafts?locale=${l}`);
      const d = await r.json();
      setEdits(d.drafts ?? {});
      setDraftCount(d.count ?? 0);
    } catch {
      setStatus("Couldn't load drafts.");
    }
  }, []);
  useEffect(() => {
    void loadDrafts(effectiveLocale);
  }, [effectiveLocale, loadDrafts]);

  // --- re-render the preview as the edits change (debounced) ---
  useEffect(() => {
    const t = setTimeout(() => {
      fetch("/api/messages/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, locale: effectiveLocale, edits }),
      })
        .then((r) => r.json())
        .then((d) => (d.error ? setStatus(d.error) : setPreview(d)))
        .catch(() => setStatus("Preview failed."));
    }, 180);
    return () => clearTimeout(t);
  }, [messageId, effectiveLocale, edits]);

  // Switching message or locale invalidates any focus/freeze state the old
  // iframe document held: the iframe below remounts (key={messageId+locale}),
  // so a stale postMessage from the previous document can't land here either.
  useEffect(() => {
    setIframeFocused(false);
    setIframeFocusKey(null);
  }, [messageId, effectiveLocale]);

  const saveDraft = useCallback(
    async (key: string, value: string) => {
      await fetch("/api/messages/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", locale: effectiveLocale, key, value }),
      });
      void loadDrafts(effectiveLocale);
    },
    [effectiveLocale, loadDrafts]
  );

  // --- messages from inside the preview iframe: click, focus, blur, input ---
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.source !== "fc-preview") return;
      const { type, key, html } = e.data as { type?: string; key?: string; html?: string };
      if (typeof key !== "string") return;

      if (type === "input") {
        lastIframeHtml.current[key] = html ?? "";
        setEdits((prev) => ({ ...prev, [key]: html ?? "" }));
        return;
      }
      if (type === "focus") {
        setFocusKey(key);
        setIframeFocusKey(key);
        setIframeFocused(true);
        return;
      }
      if (type === "blur") {
        setIframeFocused(false);
        setIframeFocusKey((k) => (k === key ? null : k));
        const value = lastIframeHtml.current[key] ?? html;
        if (typeof value === "string") void saveDraft(key, value);
        return;
      }
      // 'click' on a non-editable wrapper: focus the matching field instead.
      setFocusKey(key);
      const el = fieldRefs.current[key];
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.focus();
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [saveDraft]);

  const valueFor = (key: string) => edits[key] ?? preview?.values[key] ?? "";

  // Insert a variable at the caret rather than appending: an author clicking
  // {city} mid-sentence means "here". Only this message's own variables are
  // offered: {payout} in a recruiting email would reach a florist as a
  // literal token.
  function insertVariable(key: string, name: string) {
    const el = fieldRefs.current[key];
    const token = `{${name}}`;
    const currentValue = valueFor(key);
    if (!el) {
      setEdits((prev) => ({ ...prev, [key]: currentValue + token }));
      return;
    }
    const start = el.selectionStart ?? currentValue.length;
    const end = el.selectionEnd ?? start;
    const next = currentValue.slice(0, start) + token + currentValue.slice(end);
    setEdits((prev) => ({ ...prev, [key]: next }));
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + token.length;
      el.setSelectionRange(caret, caret);
    });
  }

  // Draft the other five locales for one English string. Everything lands as a
  // draft; a candidate that fails a guard (lost placeholder, non-GSM-7 SMS, em
  // dash) produces no draft and says why.
  async function translate(key: string) {
    setTranslating(key);
    setStatus(null);
    try {
      const r = await fetch("/api/messages/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: valueFor(key) }),
      });
      const d = await r.json();
      if (d.error) {
        setStatus(d.error);
        return;
      }
      const parts: string[] = [];
      if (d.drafted?.length) parts.push(`Drafted ${d.drafted.map((l: string) => l.toUpperCase()).join(", ")}.`);
      for (const rej of d.rejected ?? []) parts.push(`${rej.locale.toUpperCase()} rejected: ${rej.reasons.join(" ")}`);
      setStatus(parts.join(" ") || "Nothing to draft.");
    } catch {
      setStatus("Translation failed.");
    } finally {
      setTranslating(null);
    }
  }

  /** Simple mode saves only the message on screen. Full mode keeps the
   *  locale-wide behaviour its draft counter describes. */
  async function act(action: "publish" | "discard", keys?: string[]) {
    const n = draftCount;
    if (action === "publish" && n === 0 && !keys) return;
    // Scoped saves don't need the count in the sentence — it's this message —
    // and simple mode doesn't ask at all: Save is what the button says.
    if (!keys) {
      const ok = window.confirm(
        action === "publish"
          ? `Publish ${n} change${n === 1 ? "" : "s"} to ${effectiveLocale.toUpperCase()}? They go live to real recipients immediately.`
          : `Discard ${n} unpublished change${n === 1 ? "" : "s"} to ${effectiveLocale.toUpperCase()}?`
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/messages/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, locale: effectiveLocale, ...(keys ? { keys } : {}) }),
      });
      const d = await r.json();
      setStatus(d.error ?? (action === "publish" ? (keys ? "Saved." : `Published ${d.published} change${d.published === 1 ? "" : "s"}.`) : "Discarded."));
      if (!keys) setEdits({});
      await loadDrafts(effectiveLocale);
    } finally {
      setBusy(false);
    }
  }

  // --- body segments (email.offer.blocks) ---

  // The current override, if a valid one is drafted. Reusing parseBlocks
  // (rather than a hand-rolled JSON.parse) means a malformed draft degrades
  // to "not in blocks mode" exactly the way the real render pipeline does.
  const parsedBlocks = useMemo(
    () => (blocksSupported ? parseBlocks(edits[BLOCKS_KEY]) : null),
    [blocksSupported, edits]
  );

  // Not yet in blocks mode: reconstruct the fixed body's shape (greeting/
  // intro, the four flow steps, closing) from the SAME field values the
  // side panel already shows, so segment editing has something sensible to
  // start from and never discards an in-progress unsaved edit to do it.
  function buildFixedBlocks(): Block[] {
    const out: Block[] = [];
    const push = (key: string) => {
      const v = valueFor(key).trim();
      if (v) out.push({ type: "paragraph", html: v });
    };
    if (messageId === "offer.short") {
      push("email.offer.short.greeting");
      push("email.offer.short.reminder");
      push("email.offer.short.lead");
    } else {
      push("email.offer.greeting");
      push(preview?.keys.includes("email.offer.intro") ? "email.offer.intro" : "email.offer.introNoCity");
      push("email.offer.orderLead");
    }
    const steps = [1, 2, 3, 4].map((n) => valueFor(`email.offer.flowStep${n}`).trim()).filter(Boolean);
    if (steps.length) out.push({ type: "steps", items: steps });
    push(messageId === "offer.short" ? "email.offer.short.closing" : "email.offer.closing");
    return out;
  }

  function currentOrFixedBlocks(): Block[] {
    return parsedBlocks ?? buildFixedBlocks();
  }

  function updateBlocksLocal(next: Block[]) {
    setEdits((prev) => ({ ...prev, [BLOCKS_KEY]: serializeBlocks(next) }));
  }

  function commitBlocksNow(next: Block[]) {
    const json = serializeBlocks(next);
    // A paragraph/heading emptied out (or a steps block with an emptied item)
    // fails parseBlocks' own validation, and the render pipeline's answer to
    // an invalid override is to silently fall back to the FIXED body, not
    // just drop that one segment. Catching it here, with the exact same
    // validator, means the author sees why instead of the whole custom body
    // quietly vanishing on next preview refresh.
    if (!parseBlocks(json)) {
      setStatus("That would leave a segment empty, which blanks the whole custom body. Add text back, or delete the segment instead.");
      return;
    }
    setEdits((prev) => ({ ...prev, [BLOCKS_KEY]: json }));
    void saveDraft(BLOCKS_KEY, json);
  }

  function mutateBlocks(mutate: (base: Block[]) => Block[], commit: boolean) {
    const next = mutate(currentOrFixedBlocks());
    if (commit) commitBlocksNow(next);
    else updateBlocksLocal(next);
  }

  function addParagraph() {
    mutateBlocks((base) => [...base, { type: "paragraph", html: "New paragraph. Click to edit." }], true);
  }

  function deleteSegment(i: number) {
    const base = currentOrFixedBlocks();
    if (base.length <= 1) {
      setStatus("Can't delete the last segment: a message needs a body.");
      return;
    }
    mutateBlocks((b) => b.filter((_, idx) => idx !== i), true);
  }

  function moveSegment(i: number, dir: -1 | 1) {
    const base = currentOrFixedBlocks();
    const j = i + dir;
    if (j < 0 || j >= base.length) return;
    mutateBlocks((b) => {
      const next = b.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    }, true);
  }

  function setSegmentHtml(i: number, html: string, commit: boolean) {
    mutateBlocks((b) => b.map((blk, idx) => (idx === i ? { ...blk, html } : blk)), commit);
  }

  function setStepItem(i: number, itemIdx: number, text: string, commit: boolean) {
    mutateBlocks(
      (b) =>
        b.map((blk, idx) => {
          if (idx !== i || blk.type !== "steps") return blk;
          const items = (blk.items ?? []).slice();
          items[itemIdx] = text;
          return { ...blk, items };
        }),
      commit
    );
  }

  function revertToDefaultBody() {
    if (!window.confirm("Revert to the default body? This discards the custom segments draft.")) return;
    setEdits((prev) => {
      const next = { ...prev };
      delete next[BLOCKS_KEY];
      return next;
    });
    void saveDraft(BLOCKS_KEY, ""); // empty value clears the draft, same convention as every other field
  }

  const displayBlocks = blocksSupported ? currentOrFixedBlocks() : [];

  // Which catalog key produced the subject. The preview route reports it, so
  // the simple-mode field writes the right key even for a message whose
  // subject has a NoCity sibling.
  const subjectKey = preview?.subjectKeys?.[0] ?? null;

  // Which list row we are on (the email), and its text twin if it has one.
  // `messageId` may be either half of the pair, so resolve back to the email.
  const siblings = scope?.siblings;
  const emailId = useMemo(() => {
    if (!siblings) return messageId;
    if (siblings[messageId]) return messageId;
    const owner = Object.entries(siblings).find(([, sms]) => sms === messageId);
    return owner ? owner[0] : messageId;
  }, [siblings, messageId]);
  const twin = siblings?.[emailId] ?? null;

  // The selected message vanished — its duplicate was deleted, or the funnel
  // changed under us. Fall back to the first row rather than leaving the pane
  // rendering something that is no longer in the list. A text twin is
  // legitimately not a row, so selecting one is not "vanished".
  useEffect(() => {
    if (messages.length === 0) return;
    if (messages.some((m) => m.id === messageId)) return;
    if (siblings && Object.values(siblings).includes(messageId)) return;
    setMessageId(messages[0].id);
  }, [messages, messageId, siblings]);

  /** Simple mode's "Undo", scoped to the message on screen.
   *
   *  Press once and you are back to the saved version; press again and you are
   *  back to the wording we shipped. Two presses rather than two buttons: the
   *  first is free (nothing live is lost), the second asks, because it throws
   *  away a change someone deliberately published. */
  const liveOverrides = preview?.keys.filter((k) => preview.values[k] != null) ?? [];
  const unsavedHere = preview?.keys.some((k) => k in edits) ?? false;
  const canUndo = unsavedHere || liveOverrides.length > 0;

  async function undo() {
    if (!preview) return;
    const toLive = !unsavedHere;
    if (toLive && !window.confirm("Put this message back to its original wording?")) return;
    setBusy(true);
    try {
      const r = await fetch("/api/messages/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revert", locale: effectiveLocale, keys: preview.keys, published: toLive }),
      });
      const d = await r.json();
      if (d.error) { setStatus(d.error); return; }
      setStatus(toLive ? "Back to the original wording." : "Back to the saved version.");
      await loadDrafts(effectiveLocale);
    } finally {
      setBusy(false);
    }
  }

  /** Simple mode's language button: draft all five other locales for every
   *  field of this message.
   *
   *  Editing English does NOT change the other languages — overrides are keyed
   *  per locale, so Spanish keeps saying whatever Spanish said. That is safe,
   *  and it is also how a funnel ends up sending the new wording in English
   *  and the old wording in five other markets. This is the way out, and it
   *  lands as drafts like everything else, so nothing goes live unreviewed. */
  async function translateAll() {
    if (!preview) return;
    setTranslating("all");
    let done = 0;
    const problems: string[] = [];
    try {
      for (const key of preview.keys) {
        const r = await fetch("/api/messages/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, value: edits[key] ?? preview.defaults?.[key] ?? "" }),
        });
        const d = await r.json().catch(() => ({}));
        if (d.error) problems.push(`${key.split(".").pop()}: ${d.error}`);
        else done++;
      }
      setStatus(
        problems.length === 0
          ? `Drafted ${done} field${done === 1 ? "" : "s"} in the other 5 languages. Check each one and save.`
          : `Drafted ${done}; ${problems.length} could not be translated (${problems[0]}).`
      );
      await loadDrafts(effectiveLocale);
    } finally {
      setTranslating(null);
    }
  }

  /** Simple mode's second button: send this message, as it stands on screen
   *  (drafts and all), to the configured test inbox. Same route /flows uses —
   *  it takes no recipient, so there is nothing here to point at a florist. */
  async function sendTest() {
    setTesting(true);
    try {
      const r = await fetch("/api/flows/test-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, locale: effectiveLocale, edits }),
      });
      const d = await r.json();
      setStatus(d.ok ? `Test sent to ${d.to}.` : (d.error ?? "The test could not be sent."));
    } catch {
      setStatus("The test could not be sent.");
    } finally {
      setTesting(false);
    }
  }

  const computedSrcDoc = preview
    ? preview.channel === "email"
      ? preview.html + PREVIEW_BRIDGE
      : `<body style="margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#EDEFEC;padding:20px">
           <div style="max-width:340px;margin:0 auto;background:#fff;border-radius:16px;padding:14px 16px;box-shadow:0 1px 3px rgba(0,0,0,.12);white-space:pre-wrap">${preview.text
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")}</div>
         </body>${PREVIEW_BRIDGE}`
    : "";

  // Never swap the iframe's srcDoc while it holds focus: React would replace
  // its live DOM (including whatever the user is mid-typing) and drop the
  // caret. The frozen value is exactly what was showing right before focus
  // landed, so nothing visibly changes; new preview renders resume once the
  // user clicks or tabs away.
  const frozenSrcDoc = useRef<string>("");
  useEffect(() => {
    if (!iframeFocused) frozenSrcDoc.current = computedSrcDoc;
  }, [computedSrcDoc, iframeFocused]);
  const srcDoc = iframeFocused ? frozenSrcDoc.current : computedSrcDoc;

  return (
    <div className="ds" style={{ display: "grid", gridTemplateColumns: simple ? "230px minmax(0,1fr)" : "230px minmax(0,1fr) 340px", gap: 16, alignItems: "start" }}>
      {/* message list */}
      <aside style={{ position: "sticky", top: 16 }}>
        <div className="mini-h" style={{ marginBottom: 8 }}>{simple ? "What we send" : "Messages"}</div>
        <div style={{ display: "grid", gap: 2 }}>
          {messages.map((m) => {
            const selected = m.id === (simple ? emailId : messageId);
            const row = scope?.rowState?.[m.id];
            const off = row?.off ?? false;
            return (
              <div
                key={m.id}
                draggable={Boolean(row?.isCopy && scope?.onReorderRow)}
                onDragStart={() => setDragging(m.id)}
                onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                onDragOver={(ev) => {
                  if (!dragging || dragging === m.id) return;
                  ev.preventDefault(); // without this the drop never fires
                  setDropTarget(m.id);
                }}
                onDragLeave={() => setDropTarget((t) => (t === m.id ? null : t))}
                onDrop={(ev) => {
                  ev.preventDefault();
                  const moved = dragging;
                  setDragging(null);
                  setDropTarget(null);
                  if (moved && moved !== m.id) void scope?.onReorderRow?.(moved, m.id);
                }}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "6px 9px", borderRadius: 8,
                  border: "1px solid " + (selected ? "var(--accent)" : "transparent"),
                  background: selected ? "var(--surface)" : "transparent",
                  // Where it would land, and what is moving.
                  borderBottom: dropTarget === m.id ? "2px solid var(--accent)" : undefined,
                  opacity: dragging === m.id ? 0.4 : 1,
                  cursor: row?.isCopy && scope?.onReorderRow ? "grab" : undefined,
                }}
              >
                {row?.isCopy && scope?.onReorderRow && (
                  <span
                    aria-hidden
                    title="Drag to move this copy"
                    style={{ flex: "none", color: "var(--ink-faint)", fontSize: ".8rem", lineHeight: 1, cursor: "grab" }}
                  >
                    ⠿
                  </span>
                )}
                {/* The tick. Only where switching off is a real thing this
                    row can do — see rowState. */}
                {row?.canToggle && (
                  <input
                    type="checkbox"
                    checked={!off}
                    aria-label={off ? `Switch ${m.label} on` : `Switch ${m.label} off`}
                    title={off ? "Switched off — we are not sending this" : "Sending"}
                    onChange={(ev) => void scope?.onToggleRow?.(m.id, ev.target.checked)}
                    style={{ flex: "none", cursor: "pointer" }}
                  />
                )}
                <button
                  type="button"
                  onClick={() => setMessageId(m.id)}
                  style={{
                    flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none",
                    padding: 0, fontSize: ".84rem", cursor: "pointer",
                    // Switched off reads as switched off: the row stays legible
                    // and editable, it just stops looking like something we send.
                    color: off ? "var(--ink-faint)" : "var(--ink)",
                    textDecoration: off ? "line-through" : "none",
                  }}
                >
                  {m.label}
                  {!simple && (
                    <span style={{ display: "block", fontSize: ".7rem", color: "var(--ink-faint)" }}>
                      {m.channel === "sms" ? "SMS" : "Email"} · {m.audience}
                      {m.localized ? "" : " · EN only"}
                    </span>
                  )}
                </button>

                {/* Duplicate and delete. Shown on the selected row only, so
                    the list stays a list of names and not a grid of buttons. */}
                {selected && row?.canDuplicate && (
                  <button
                    type="button"
                    title="Add a copy of this email below it"
                    aria-label={`Duplicate ${m.label}`}
                    onClick={() => void scope?.onDuplicateRow?.(m.id)}
                    style={rowActionStyle}
                  >
                    <Copy size={13} />
                  </button>
                )}
                {selected && row?.isCopy && (
                  <button
                    type="button"
                    title="Delete this copy"
                    aria-label={`Delete ${m.label}`}
                    onClick={() => void scope?.onDeleteRow?.(m.id)}
                    style={rowActionStyle}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      {/* preview */}
      <section>
        <header style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: "1.05rem" }}>{current?.label ?? preview?.label ?? "…"}</h2>
            {current && !current.localized && (
              <span style={{ fontSize: ".74rem", color: "var(--ink-faint)" }}>English only, not translated</span>
            )}
          </div>
          {!simple && (
            <p style={{ margin: "4px 0 0", fontSize: ".82rem", color: "var(--ink-soft)" }}>{preview?.note}</p>
          )}

          {/* Email / Text, when this message has both. One control, and it
              swaps what is being edited rather than navigating anywhere. */}
          {simple && twin && (
            <div style={{ display: "inline-flex", marginTop: 10, border: "1px solid var(--line-strong)", borderRadius: 8, overflow: "hidden" }}>
              {([[emailId, "Email"], [twin, "Text"]] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setMessageId(id)}
                  style={{
                    border: "none", cursor: "pointer", padding: "5px 14px", font: "600 .76rem var(--sans)",
                    background: messageId === id ? "var(--accent)" : "var(--surface)",
                    color: messageId === id ? "#fff" : "var(--ink-soft)",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* The subject line. In simple mode it is a real field right here:
              with the catalog-key panel hidden it would otherwise be the one
              thing on the screen you could read but not change — and it is the
              single most-edited line we have. */}
          {preview?.channel === "email" && (simple ? (
            <label style={{ display: "block", margin: "10px 0 0" }}>
              <span className="mini-h">Subject line</span>
              <input
                type="text"
                value={
                  subjectKey
                    ? edits[subjectKey] ?? preview.defaults?.[subjectKey] ?? ""
                    : preview.subject
                }
                disabled={!subjectKey}
                onChange={(e) => subjectKey && setEdits((prev) => ({ ...prev, [subjectKey]: e.target.value }))}
                onBlur={(e) => subjectKey && void saveDraft(subjectKey, e.target.value)}
                style={{
                  width: "100%", marginTop: 4, fontSize: ".92rem", padding: "8px 10px",
                  border: "1px solid var(--line-strong)", borderRadius: 8,
                  background: "var(--surface)", color: "var(--ink)",
                }}
              />
            </label>
          ) : preview.subject ? (
            <p style={{ margin: "8px 0 0", fontSize: ".86rem" }}>
              <span className="mini-h">Subject</span>{" "}
              <span style={{ fontWeight: 600 }}>{preview.subject}</span>
            </p>
          ) : null)}

          {simple && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="btn btn-solid"
                disabled={busy || !unsavedHere}
                onClick={() => act("publish", preview?.keys)}
              >
                {unsavedHere ? "Save" : "Saved"}
              </button>
              <button type="button" className="btn" disabled={testing} onClick={() => void sendTest()}>
                {testing ? "Sending…" : "Send me a test"}
              </button>
              {effectiveLocale === "en" && current?.localized && (
                <button
                  type="button"
                  className="btn"
                  disabled={translating !== null}
                  title="Rewrite this message in the other five languages, as drafts"
                  onClick={() => void translateAll()}
                >
                  {translating ? "Translating…" : "Translate"}
                </button>
              )}
              {canUndo && (
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void undo()}>
                  Undo
                </button>
              )}
              {status && <span style={{ fontSize: ".74rem", color: "var(--ink-faint)" }}>{status}</span>}
            </div>
          )}
          {preview?.segments != null && !simple && (
            <p style={{ margin: "8px 0 0", fontSize: ".8rem", color: preview.segments > 3 ? "var(--crit)" : "var(--ink-faint)" }}>
              {preview.segments} SMS segment{preview.segments === 1 ? "" : "s"}: every send is billed per segment.
            </p>
          )}
        </header>

        {iframeFocusKey && preview?.channel === "email" && (
          <FormatButtons
            onCommand={(cmd, value) => {
              iframeRef.current?.contentWindow?.postMessage({ source: "fc-editor", type: "exec", cmd, value }, "*");
            }}
            note="Bold, italic and links only render in a real send for the body segments below today. Other fields still send as plain text until their template supports rich text."
          />
        )}

        <iframe
          ref={iframeRef}
          key={messageId + ":" + effectiveLocale}
          title="Message preview"
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          style={{ width: "100%", height: "70vh", border: "1px solid var(--line-strong)", borderRadius: 12, background: "#fff" }}
        />
        <p style={{ margin: "8px 0 0", fontSize: ".76rem", color: "var(--ink-faint)" }}>
          Click any highlighted text to change it.
        </p>

        {/* The segment builder. Hidden in simple mode: /flows is for changing
            what an email SAYS, and a panel that rebuilds the body out of
            numbered blocks is a different, much rarer job that reads as
            clutter next to a subject line. Still available on /messages. */}
        {blocksSupported && !simple && (
          <div style={{ marginTop: 16, border: "1px solid var(--line-strong)", borderRadius: 10, padding: 12, background: "var(--surface)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
              <div>
                <div className="mini-h">Body segments</div>
                <p style={{ margin: "2px 0 0", fontSize: ".76rem", color: "var(--ink-faint)" }}>
                  Optional. Replaces the fixed body above with your own paragraphs and steps, in order.
                </p>
              </div>
              {parsedBlocks && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ padding: "3px 8px", fontSize: ".7rem", whiteSpace: "nowrap" }}
                  onClick={revertToDefaultBody}
                >
                  Use default body
                </button>
              )}
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              {displayBlocks.map((block, i) => (
                <div key={i} style={{ border: "1px solid var(--line-strong)", borderRadius: 8, padding: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <span className="mini-h">
                      {block.type === "steps" ? "Numbered steps" : block.type === "heading" ? "Heading" : "Paragraph"}
                    </span>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        type="button"
                        title="Move up"
                        aria-label="Move segment up"
                        disabled={i === 0}
                        onClick={() => moveSegment(i, -1)}
                        style={{ ...toolbarBtnStyle, opacity: i === 0 ? 0.4 : 1, cursor: i === 0 ? "not-allowed" : "pointer" }}
                      >
                        <ArrowUp size={13} />
                      </button>
                      <button
                        type="button"
                        title="Move down"
                        aria-label="Move segment down"
                        disabled={i === displayBlocks.length - 1}
                        onClick={() => moveSegment(i, 1)}
                        style={{
                          ...toolbarBtnStyle,
                          opacity: i === displayBlocks.length - 1 ? 0.4 : 1,
                          cursor: i === displayBlocks.length - 1 ? "not-allowed" : "pointer",
                        }}
                      >
                        <ArrowDown size={13} />
                      </button>
                      <button
                        type="button"
                        title="Delete segment"
                        aria-label="Delete segment"
                        disabled={displayBlocks.length <= 1}
                        onClick={() => deleteSegment(i)}
                        style={{
                          ...toolbarBtnStyle,
                          opacity: displayBlocks.length <= 1 ? 0.4 : 1,
                          cursor: displayBlocks.length <= 1 ? "not-allowed" : "pointer",
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  {block.type === "steps" ? (
                    <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
                      {(block.items ?? []).map((item, ii) => (
                        <li key={ii}>
                          <SegmentField
                            html={item}
                            ariaLabel={`Step ${ii + 1}`}
                            onChange={(v) => setStepItem(i, ii, v, false)}
                            onCommit={(v) => setStepItem(i, ii, v, true)}
                          />
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <SegmentField
                      html={block.html ?? ""}
                      ariaLabel={block.type === "heading" ? "Heading text" : "Paragraph text"}
                      onChange={(v) => setSegmentHtml(i, v, false)}
                      onCommit={(v) => setSegmentHtml(i, v, true)}
                    />
                  )}
                </div>
              ))}
            </div>

            <button
              type="button"
              className="btn"
              style={{ marginTop: 8, padding: "5px 10px", fontSize: ".78rem" }}
              onClick={addParagraph}
            >
              <Plus size={13} /> Add paragraph
            </button>

            <p style={{ margin: "8px 0 0", fontSize: ".7rem", color: "var(--ink-faint)" }}>
              Segments save as a draft the same way the fields on the right do, and publish with the rest.
            </p>
          </div>
        )}
      </section>

      {/* fields — the raw catalog keys. Hidden in simple mode: `shell.footer`
          and `t2.greeting` are names only this repo uses, and the message
          itself is editable in the preview above. */}
      {!simple && (
      <aside style={{ position: "sticky", top: 16, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {locales.map((l) => (
            <button
              key={l}
              type="button"
              disabled={current ? !current.localized && l !== "en" : false}
              onClick={() => setLocale(l)}
              className={l === effectiveLocale ? "btn btn-solid" : "btn"}
              style={{ padding: "4px 9px", fontSize: ".74rem", opacity: current && !current.localized && l !== "en" ? 0.4 : 1 }}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>

        <div style={{ border: "1px solid var(--line-strong)", borderRadius: 10, padding: 10, background: "var(--surface)" }}>
          <div style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>
            {draftCount === 0 ? (
              "No unpublished changes."
            ) : (
              <b style={{ color: "var(--ink)" }}>
                {draftCount} unpublished change{draftCount === 1 ? "" : "s"} in {effectiveLocale.toUpperCase()}
              </b>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button type="button" className="btn btn-solid" disabled={busy || draftCount === 0} onClick={() => act("publish")}>
              Publish
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy || draftCount === 0} onClick={() => act("discard")}>
              Discard
            </button>
          </div>
          {status && <p style={{ margin: "8px 0 0", fontSize: ".76rem", color: "var(--ink-faint)" }}>{status}</p>}
        </div>

        {preview?.warnings.map((w, i) => (
          <p key={i} style={{ margin: 0, fontSize: ".76rem", color: "var(--crit)", border: "1px solid var(--crit)", borderRadius: 8, padding: "6px 8px" }}>
            {w.key ? `${w.key}: ` : ""}
            {w.message}
          </p>
        ))}

        <div style={{ display: "grid", gap: 10, maxHeight: "60vh", overflowY: "auto" }}>
          {preview?.keys.map((key) => (
            <label key={key} style={{ display: "grid", gap: 3 }}>
              <span
                className="mini-h"
                style={{ color: key === focusKey ? "var(--accent)" : undefined, wordBreak: "break-all" }}
              >
                {key.replace(/^email\.|^sms\./, "")}
              </span>
              <textarea
                ref={(el) => {
                  fieldRefs.current[key] = el;
                }}
                value={valueFor(key)}
                rows={Math.min(6, Math.max(2, Math.ceil(valueFor(key).length / 44)))}
                onFocus={() => setFocusKey(key)}
                onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                onBlur={(e) => void saveDraft(key, e.target.value)}
                style={{
                  width: "100%", fontSize: ".8rem", lineHeight: 1.45, padding: "6px 8px",
                  border: "1px solid " + (key === focusKey ? "var(--accent)" : "var(--line-strong)"),
                  borderRadius: 8, background: "var(--surface-2)", color: "var(--ink)", resize: "vertical",
                }}
              />
              {key === focusKey && (preview?.variables?.length ?? 0) > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {preview!.variables.map((v) => (
                    <button
                      key={v.name}
                      type="button"
                      title={`${v.what}  e.g. ${v.example}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insertVariable(key, v.name)}
                      style={{
                        padding: "2px 6px", fontSize: ".68rem", fontFamily: "var(--mono)",
                        borderRadius: 6, border: "1px solid var(--line-strong)",
                        background: "var(--surface)", color: "var(--accent)", cursor: "pointer",
                      }}
                    >
                      {`{${v.name}}`}
                    </button>
                  ))}
                </div>
              )}
              {effectiveLocale === "en" && current?.localized && (
                <button
                  type="button"
                  className="btn"
                  disabled={translating === key}
                  onClick={() => void translate(key)}
                  style={{ justifySelf: "start", padding: "3px 8px", fontSize: ".7rem" }}
                >
                  {translating === key ? "Translating…" : "Draft the other 5 languages"}
                </button>
              )}
            </label>
          ))}
        </div>
      </aside>
      )}
    </div>
  );
}
