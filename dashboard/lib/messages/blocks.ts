// The block model: a message body as ordered DATA rather than a fixed builder
// sequence, so the editor can add, remove and reorder segments.
//
// Opt-in and additive. A message renders from blocks only when a
// `<message>.blocks` override exists; with none, every builder behaves exactly
// as it does today and every existing send is byte-identical. That is the whole
// safety story: turning this on is a per-message, per-locale act, and deleting
// the override reverts it.
//
// Block CONTENT is staff-authored rich text, so it goes through the same
// allowlist as everything else (lib/messages/richText.ts) at render time, on
// top of the sanitising already done on save.
import { sanitizeRichText, richTextToPlain } from "./richText.ts";

export type BlockType = "paragraph" | "heading" | "steps";

export interface Block {
  type: BlockType;
  /** Rich text for paragraph/heading. */
  html?: string;
  /** Ordered items for a steps block. */
  items?: string[];
}

/** Parse a stored blocks override. Returns null for anything it can't read,
 * so the caller falls back to the builder's fixed sequence rather than
 * rendering an empty email — a malformed override must degrade, never blank. */
export function parseBlocks(raw: string | null | undefined): Block[] | null {
  if (!raw || typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const out: Block[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") return null;
    const { type, html, items } = item as Record<string, unknown>;
    if (type === "paragraph" || type === "heading") {
      if (typeof html !== "string" || !html.trim()) return null;
      out.push({ type, html });
    } else if (type === "steps") {
      if (!Array.isArray(items) || items.length === 0) return null;
      if (!items.every((s) => typeof s === "string" && s.trim())) return null;
      out.push({ type: "steps", items: items as string[] });
    } else {
      return null; // unknown type: refuse the whole override rather than skip
    }
  }
  return out;
}

export function serializeBlocks(blocks: Block[]): string {
  return JSON.stringify(blocks);
}

const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Render blocks to email HTML. Table-based and inline-styled like every other
 * helper here, and matching what the offer email's own renderers produce, so a
 * body switched to blocks doesn't visibly change shape. */
export function renderBlocksHtml(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if (b.type === "heading") {
        return `<p style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:20px;font-weight:700;color:#16211B">${sanitizeRichText(b.html ?? "")}</p>`;
      }
      if (b.type === "steps") {
        const rows = (b.items ?? [])
          .map(
            (s, i) => `
        <tr>
          <td width="26" valign="top" style="padding:${i === 0 ? "0" : "10px"} 0 0 0;font-family:${FONT_STACK};font-size:15px;line-height:1.5;font-weight:700;color:#1F7A55">${i + 1}.</td>
          <td valign="top" style="padding:${i === 0 ? "0" : "10px"} 0 0 0;font-family:${FONT_STACK};font-size:15px;line-height:1.5;color:#52625A">${sanitizeRichText(s)}</td>
        </tr>`
          )
          .join("");
        return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px 0">${rows}
      </table>`;
      }
      return `<p style="margin:0 0 14px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.5;color:#52625A">${sanitizeRichText(b.html ?? "")}</p>`;
    })
    .join("");
}

/** The plain-text alternative, derived from the same blocks so it can never
 * say something the HTML part doesn't. */
export function renderBlocksText(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "steps") {
      (b.items ?? []).forEach((s, i) => parts.push(`${i + 1}. ${richTextToPlain(s)}`));
      parts.push("");
    } else {
      parts.push(richTextToPlain(b.html ?? ""));
      parts.push("");
    }
  }
  while (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts.join("\n");
}

/** Every editable text fragment in a block list, in document order. The editor
 * uses this to know what it can offer as separate fields. */
export function blockTexts(blocks: Block[]): string[] {
  return blocks.flatMap((b) => (b.type === "steps" ? (b.items ?? []) : [b.html ?? ""]));
}
