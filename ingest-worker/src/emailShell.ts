// The branded Facundo email shell, ported for the Worker.
//
// This is a deliberate duplicate of dashboard/lib/emailTemplate.ts's `branded`
// voice, for the same reason db.ts::logExternalOp duplicates the dashboard's
// version: the Worker cannot import across the package boundary. Keep the two
// visually in step -- the brand tokens below are copied verbatim, so a change
// there should be mirrored here.
//
// Only the branded voice is ported. The `plain` persona voice, i18n/overrides,
// unsubscribe and rich-text sanitising are all recruiting-side concerns that a
// staff-internal digest has no use for.
//
// Email clients are hostile to modern CSS, so this is deliberately primitive --
// table layout only, every style inlined per element, no CSS variables, no
// flex/grid, explicit width/height on the one image.

const BRAND_GREEN = "#1F7A55";
const HEADER_BG = "#F6F8F5";
const HEADLINE = "#16211B";
const BODY_TEXT = "#52625A";
const FOOTER_TEXT = "#7C8A81";
const RULE = "#E6EAE7";
// The second semantic colour: "this only happened because a person pushed".
const AMBER = "#C08420";
const AMBER_TEXT = "#8A6318";
const PAGE_BG = "#EDEFEC";
const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// Absolute origin -- an email has no "current page" to resolve a relative path
// against. Matches dashboard/lib/emailLinks.ts::FLORIST_BASE's production
// default (lib/hostRouting.ts::FLORIST_HOST); /brand/ is host-agnostic.
const LOGO_URL = "https://florist.fc.example.net/brand/facundo-logo-email.png";

/** Staff backoffice origin, for the CTA. Mirrors BACKOFFICE_HOST. */
export const BACKOFFICE_BASE = "https://bo.fc.example.net";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The 20px bold line at the top of the card. Keep it SHORT -- it is a headline,
 *  not a sentence. */
export function renderHeadline(text: string): string {
  return `<p style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:20px;font-weight:700;color:${HEADLINE}">${escapeHtml(text)}</p>`;
}

export function renderParagraph(text: string): string {
  return `<p style="margin:0 0 14px 0;font-family:${FONT_STACK};font-size:15px;line-height:1.5;color:${BODY_TEXT}">${escapeHtml(text)}</p>`;
}

/** A small muted section label above a facts block. */
export function renderSectionLabel(text: string): string {
  return `<p style="margin:20px 0 4px 0;font-family:${FONT_STACK};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${FOOTER_TEXT}">${escapeHtml(text)}</p>`;
}

export interface FactRow {
  label: string;
  value: string;
  /** Renders the value in the brand green — for the one number that matters. */
  emphasis?: boolean;
}

/** Facts-first key/value block: label left, bold value right, hairline rules
 *  between rows. Same shape as the dashboard's renderFactsBlock. */
export function renderFactsBlock(rows: FactRow[]): string {
  if (rows.length === 0) return "";
  const trs = rows
    .map(
      (r, i) => `
        <tr>
          <td style="padding:8px 0;${i > 0 ? `border-top:1px solid ${RULE};` : ""}font-family:${FONT_STACK};font-size:13px;color:${FOOTER_TEXT}">${escapeHtml(r.label)}</td>
          <td align="right" style="padding:8px 0;${i > 0 ? `border-top:1px solid ${RULE};` : ""}font-family:${FONT_STACK};font-size:13px;font-weight:700;color:${r.emphasis ? BRAND_GREEN : HEADLINE}">${escapeHtml(r.value)}</td>
        </tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px 0">${trs}
      </table>`;
}

/** The colour of the drop note under a bar. Only used there. */
const DROP_RED = "#A33A2B";
/** The unfilled part of a bar. */
const TRACK = "#F1F4F2";

export interface BarRow {
  label: string;
  /** How many. The fact, and the thing the eye should land on. */
  count: string;
  /** Its share of the top of the funnel, `(25%)`. Omitted on the first bar,
   *  which is the denominator and so is always 100% of itself. */
  share?: string;
  /** Percent of the bar the app filled unattended, 0 to 100. */
  alonePct: number;
  /** Percent a person had to push it to, drawn straight after the green. */
  helpedPct: number;
  /** One red line UNDER the bar, saying how many stopped before the next one. */
  drop?: string;
}

/**
 * The funnel, as horizontal bars.
 *
 * Replaces the six-dot stage strip. The dots showed how far the orders got but
 * not how many fell out between one stage and the next, which is the only
 * question CX had: on 2026-08-27 six of eight orders died between Matched and
 * Offer sent, and the dots showed that as "8" then "2" with nothing to say the
 * six were the story. A bar gives the drop somewhere to be written.
 *
 * Bars are TABLE CELLS WITH A BACKGROUND COLOUR, never a div with a width: the
 * same constraint that made the old dot strip use text bullets. Percentage widths
 * on `<td>` are one of the few layout primitives every mail client agrees on.
 *
 * A stage nothing reached still draws its empty track rather than being
 * dropped, so the shape of the funnel is the same every day and the reader's
 * eye learns where to look.
 *
 * THE COUNT AND THE SHARE ARE TWO COLUMNS, NOT ONE STRING. They shipped as one
 * bold run of digits, "4 100%", which read as a single number nobody could
 * parse at a glance (CX, 2026-08-31). They are different kinds of thing: the
 * count is the fact, the share is context for it. So the count gets its own
 * right-aligned column in the body weight, and the share sits after it in
 * brackets, small and grey. Two columns also mean the digits line up down the
 * funnel instead of ending wherever the previous number happened to stop.
 */
export function renderBars(rows: BarRow[]): string {
  const bar = (r: BarRow) => {
    const rest = Math.max(0, 100 - r.alonePct - r.helpedPct);
    const cells = [
      r.alonePct > 0
        ? `<td width="${r.alonePct}%" bgcolor="${BRAND_GREEN}" height="14" style="font-size:0;line-height:0">&nbsp;</td>`
        : "",
      r.helpedPct > 0
        ? `<td width="${r.helpedPct}%" bgcolor="${AMBER}" height="14" style="font-size:0;line-height:0">&nbsp;</td>`
        : "",
      rest > 0 ? `<td width="${rest}%" height="14" style="font-size:0;line-height:0">&nbsp;</td>` : "",
    ].join("");
    return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TRACK}"><tr>${cells}</tr></table>`;
  };

  return rows
    .map(
      (r) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${r.drop ? "4px" : "8px"} 0">
        <tr>
          <td width="120" style="font-family:${FONT_STACK};font-size:12px;color:${BODY_TEXT}">${escapeHtml(r.label)}</td>
          <td>${bar(r)}</td>
          <td width="30" align="right" style="font-family:${FONT_STACK};font-size:14px;font-weight:700;color:${HEADLINE}">${escapeHtml(r.count)}</td>
          <td width="44" align="right" style="font-family:${FONT_STACK};font-size:11px;font-weight:400;color:${FOOTER_TEXT}">${r.share ? escapeHtml(r.share) : "&nbsp;"}</td>
        </tr>
      </table>${
        r.drop
          ? `\n      <p style="margin:0 0 6px 128px;font-family:${FONT_STACK};font-size:11px;color:${DROP_RED}">${escapeHtml(r.drop)}</p>`
          : ""
      }`,
    )
    .join("");
}

/** The two colours' meaning, centred under the funnel. */
export function renderBarLegend(): string {
  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 0 0">
        <tr><td align="center" style="font-family:${FONT_STACK};font-size:11px;color:${FOOTER_TEXT}">
          <span style="color:${BRAND_GREEN}">&#9632;</span> the app, on its own &nbsp;&nbsp; <span style="color:${AMBER}">&#9632;</span> a person had to step in
        </td></tr>
      </table>`;
}

/**
 * A small green button INSIDE the card, under a facts block.
 *
 * Distinct from the one at the foot of the email (renderCta): that one is the
 * general "go and look at the numbers" link, this one hangs off a specific
 * block and takes the reader to exactly the orders that block is about. Same
 * bulletproof-ish construction, one size down.
 */
export function renderInlineCta(label: string, url: string): string {
  return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 0 0">
        <tr><td bgcolor="${BRAND_GREEN}" style="border-radius:6px">
          <a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:9px 16px;font-family:${FONT_STACK};font-size:12px;font-weight:700;color:#FFFFFF;text-decoration:none">${escapeHtml(label)}</a>
        </td></tr>
      </table>`;
}

/** One step of a column's small funnel: a label, its number, and a bar. */
export interface ColumnBar {
  label: string;
  /** How many. Same split as BarRow, for the same reason. */
  count: string;
  /** Its share of the offers at the top of this column, `(3%)`. */
  share?: string;
  /** 0 to 100. Always a share of the top of THAT column's funnel. */
  pct: number;
}

/** One heading plus its body, for a side-by-side comparison. */
export interface Column {
  heading: string;
  /** One line under the heading saying what this column is. */
  note: string;
  /** Label/value rows. */
  rows?: FactRow[];
  /** A small funnel, drawn under the rows. */
  bars?: ColumnBar[];
  /**
   * Plain sentences instead of a funnel. A day where a cohort got no offers at
   * all is better said in words than drawn as three empty bars, which look
   * like a rendering failure.
   */
  lines?: string[];
  /** Tints the column so the two are told apart without reading. */
  tone: "green" | "amber";
}

/**
 * Two columns side by side.
 *
 * A table, not a grid: this is the one block in the digest that must survive
 * Outlook, and `display:grid` is ignored there, which would stack the two
 * cohorts and lose the comparison that is the whole point of splitting them.
 */
export function renderColumns(left: Column, right: Column): string {
  const cell = (c: Column) => {
    // The fill matches the column's tint, and both match the funnel above:
    // green is what the app may do unattended, amber is what only happens when
    // a person sends it. Network shops are green for exactly that reason, so
    // the reader learns one colour rule and it holds for the whole email.
    const fill = c.tone === "green" ? BRAND_GREEN : AMBER;
    const rows = (c.rows ?? [])
      .map(
        (r, i) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="padding:5px 0;${i > 0 ? `border-top:1px solid ${RULE};` : ""}font-family:${FONT_STACK};font-size:13px;color:${FOOTER_TEXT}">${escapeHtml(r.label)}</td>
              <td align="right" style="padding:5px 0;${i > 0 ? `border-top:1px solid ${RULE};` : ""}font-family:${FONT_STACK};font-size:13px;font-weight:700;color:${r.emphasis ? BRAND_GREEN : HEADLINE}">${escapeHtml(r.value)}</td>
            </tr></table>`,
      )
      .join("");
    const lines = (c.lines ?? [])
      .map(
        (line) =>
          `<p style="margin:0 0 6px 0;font-family:${FONT_STACK};font-size:12px;line-height:1.5;color:${HEADLINE}">${escapeHtml(line)}</p>`,
      )
      .join("");
    const bars = (c.bars ?? [])
      .map(
        (b) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 9px 0">
              <tr>
                <td style="font-family:${FONT_STACK};font-size:12px;color:${BODY_TEXT}">${escapeHtml(b.label)}</td>
                <td width="30" align="right" style="font-family:${FONT_STACK};font-size:14px;font-weight:700;color:${HEADLINE}">${escapeHtml(b.count)}</td>
                <td width="40" align="right" style="font-family:${FONT_STACK};font-size:11px;font-weight:400;color:${FOOTER_TEXT}">${b.share ? escapeHtml(b.share) : "&nbsp;"}</td>
              </tr>
              <tr><td colspan="3" style="padding-top:4px">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#E7ECE9"><tr>${
                  b.pct > 0
                    ? `<td width="${b.pct}%" bgcolor="${fill}" height="8" style="font-size:0;line-height:0">&nbsp;</td>`
                    : ""
                }${
                  b.pct < 100
                    ? `<td width="${100 - b.pct}%" height="8" style="font-size:0;line-height:0">&nbsp;</td>`
                    : ""
                }</tr></table>
              </td></tr>
            </table>`,
      )
      .join("");
    return `
          <td width="50%" valign="top" bgcolor="${c.tone === "green" ? "#F3F8F5" : "#FBF9F4"}" style="padding:14px 16px">
            <p style="margin:0 0 2px 0;font-family:${FONT_STACK};font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${c.tone === "green" ? BRAND_GREEN : AMBER_TEXT}">${escapeHtml(c.heading)}</p>
            <p style="margin:0 0 10px 0;font-family:${FONT_STACK};font-size:11px;line-height:1.4;color:${FOOTER_TEXT}">${escapeHtml(c.note)}</p>
            ${lines}${rows}${bars}
          </td>`;
  };
  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px 0;border:1px solid ${RULE};border-radius:8px">
        <tr>${cell(left)}${cell(right)}
        </tr>
      </table>`;
}

/** Small muted print under a rule — the "how to read this" note. */
export function renderFootnote(text: string): string {
  return `<p style="margin:20px 0 0 0;padding-top:14px;border-top:1px solid ${RULE};font-family:${FONT_STACK};font-size:12px;line-height:1.5;color:${FOOTER_TEXT}">${escapeHtml(text)}</p>`;
}

function renderCta(cta: { label: string; url: string }): string {
  // Bulletproof-ish button: a table cell with a background colour, because
  // Outlook ignores padding and border-radius on an <a>.
  return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0 0">
        <tr>
          <td bgcolor="${BRAND_GREEN}" style="border-radius:8px">
            <a href="${escapeHtml(cta.url)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${FONT_STACK};font-size:14px;font-weight:700;color:#FFFFFF;text-decoration:none">${escapeHtml(cta.label)}</a>
          </td>
        </tr>
      </table>`;
}

export interface ShellOptions {
  /**
   * Hidden inbox-preview snippet.
   *
   * Without this, Gmail scrapes the first visible text and runs the headline
   * straight into whatever follows -- which is how the first digest previewed
   * as "...46% the week before. Automation digest for Thu, 20 Aug 2026 ·
   * Europe/Madrid Yes", the trailing "Yes" being the start of the "YESTERDAY"
   * section label. A short preheader replaces all of that with one line we
   * actually chose.
   */
  preheader?: string;
  cta?: { label: string; url: string };
  footer?: string;
}

export function renderEmailShell(contentHtml: string, opts: ShellOptions = {}): string {
  const preheaderHtml = opts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px">${escapeHtml(opts.preheader)}</div>`
    : "";
  const footer = opts.footer ?? "Facundo internal report. Sent automatically each morning.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light" />
<title></title>
<style>
  @media only screen and (max-width: 600px) {
    .fc-container { width: 100% !important; }
    .fc-card { padding: 24px 20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${PAGE_BG}">
${preheaderHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAGE_BG}">
  <tr>
    <td bgcolor="${HEADER_BG}" style="padding:0;border-top:3px solid ${BRAND_GREEN}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center" style="padding:20px 24px">
            <img src="${LOGO_URL}" width="121" height="32" alt="Facundo" style="display:block;border:0" />
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:32px 16px">
      <table role="presentation" class="fc-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">
        <tr>
          <td class="fc-card" bgcolor="#FFFFFF" style="padding:32px;border-radius:12px">
            ${contentHtml}
${opts.cta ? renderCta(opts.cta) : ""}
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:0 24px 32px 24px">
      <p style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.5;color:${FOOTER_TEXT}">${escapeHtml(footer)}</p>
    </td>
  </tr>
</table>
</body>
</html>`;
}
