"""Async enrichment orchestration: discover a florist's real content (bounded
internal-link crawl, headless-rendering fallback for JS-shell sites), run
broadened rule-based ecommerce detection (incl. the Maps online-ordering
signal), extract email/phone/owner-name from the richer content, and fall
back to Claude when rules are ambiguous — all with an honest paper trail in
`enrichment_notes`.

Discovery pipeline per florist (bounded to `MAX_PAGES_PER_FLORIST` pages,
`PAGE_FETCH_TIMEOUT_SECONDS` each):
  1. Fetch the homepage via plain `httpx` (fast, cheap).
  2. If that response is a thin/JS-shell page (very little HTML/text/links —
     e.g. a React/Vue app that renders client-side), render it headlessly
     with Playwright to get the real DOM instead.
  3. Collect internal links from the best available homepage content, rank
     them by localized contact/shop/about/location-style keywords (with a
     generic "shallow path" fallback bonus for URLs that don't match any
     keyword but look like a top-level content page — e.g. a bare
     `/barcelona/` location subpage), and fetch/render up to the remaining
     page budget, same static-first-then-render-on-thin-content rule.
  4. If, after all that, nothing rendered and no signal (email or ecommerce)
     was found anywhere, make one last attempt: force-render the homepage
     and pull a couple more links from the rendered nav.
  5. Social handling: if the Maps "website" is itself a social/link-in-bio
     profile (Instagram, Facebook, TikTok, Linktree, etc. — see
     `is_social_url`), skip the above and instead headless-render the
     profile directly, run the same extractors over its rendered bio/meta,
     and follow the first outbound "link in bio" via the normal crawl
     (`crawl_social_site`). The reverse case — a normal site that itself
     links out to a social profile — is tried as a last resort when the
     normal crawl finds no email at all. Both paths share the same
     MAX_PAGES_PER_FLORIST budget and are best-effort/honest: a
     login-walled or blocked page is recorded in `enrichment_notes`, never
     fabricated.

Concurrency: at most `MAX_CONCURRENT_ENRICHMENTS` florists are enriched at
once (semaphore) — each doing up to `MAX_PAGES_PER_FLORIST` HTTP fetches +
up to 3 Claude calls. Headless rendering uses a SEPARATE, much lower
semaphore (`MAX_CONCURRENT_RENDERS`) shared across all florists, since
spinning up browser pages is far more expensive than an HTTP GET. A single
shared Chromium instance is reused for the whole batch. Claude's Python SDK
is synchronous, so calls are dispatched via `asyncio.to_thread` to avoid
blocking the event loop while other florists' fetches are in flight.
"""

import asyncio
import json
import re
import sys
from html import unescape as unescape_html_entities
from typing import Any
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from prompts import (
    ECOMMERCE_CLASSIFICATION_PROMPT,
    EMAIL_EXTRACTION_PROMPT,
    OWNER_INFO_PROMPT,
    PHONE_EXTRACTION_PROMPT,
    EcommerceClassification,
    EmailExtraction,
    OwnerInfo,
    PhoneExtraction,
)
from usage import MODEL_FOR_CALL
from llm_client import routed_model

USER_AGENT = "facundo-poc-ingest/0.1 (+https://fc.example.com; contact: staff@fc.example.com)"
# Raised from 5.0s/5000ms on 2026-09-03 — see
# ingest-worker/src/config.ts::FETCH_TIMEOUT_MS for why. KEEP IN STEP.
FETCH_TIMEOUT_SECONDS = 15.0
RENDER_TIMEOUT_MS = 15000
# Tuned from the Girona baseline (workstream C): enrichment is I/O-bound (HTTP
# + Anthropic waits), so more concurrency shortens wall-clock. Renders are
# memory-heavier (a Chromium context each), so they rise more modestly.
MAX_CONCURRENT_ENRICHMENTS = 10
MAX_CONCURRENT_RENDERS = 4
MAX_PAGES_PER_FLORIST = 8

# Added 2026-09-04: a real Cloudflare Workflow OOM ("Worker exceeded memory
# limit") traced to flowstore.co.il, a Wix page-builder site whose homepage
# alone is 1.15MB of HTML — crawl_site fetches up to MAX_PAGES_PER_FLORIST of
# a site's pages, and this pipeline holds the full text of each in memory at
# once. Contact info (email/phone/address) overwhelmingly lives in the head/
# nav/hero/footer, well within this cap, not deep in a page-builder's
# megabytes of embedded JS/JSON state. KEEP IN STEP with
# ingest-worker/src/config.ts::MAX_PAGE_BYTES.
MAX_PAGE_BYTES = 1_500_000

# A page is treated as a "thin/JS shell" (needs headless rendering) if its
# raw HTML is very small, or if the visible text / link count is negligible
# once parsed — catches client-rendered apps that ship an almost-empty shell
# (e.g. Floristería Ejemplo's homepage: 1.5 KB, no useful text or links; the
# real content lives on a rendered subpage).
THIN_HTML_BYTES = 2000
THIN_TEXT_CHARS = 200

SKIP_LINK_SCHEMES = ("mailto:", "tel:", "javascript:", "#")
SKIP_LINK_EXTENSIONS = (
    ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico",
    ".css", ".js", ".zip", ".mp4", ".woff", ".woff2",
)

# Localized path keywords used to prioritize the bounded internal-link crawl.
# Higher score = fetched earlier (and more likely to fit within the
# MAX_PAGES_PER_FLORIST cap).
# KEEP IN STEP with ingest-worker/src/config.ts::LINK_PRIORITY_KEYWORDS — the
# two pipelines crawl the same sites and nothing enforces that they agree.
#
# Retuned 2026-08-11 after chaine-fleurs.com: the 8-page budget went to /panier
# (cart), /mon-compte and four product collections, while
# /content/18-service-client — which holds the shop's address — scored ZERO and
# was never fetched. Two causes: the vocabulary was Spanish/Catalan/German/
# English with no French, Italian or Portuguese contact wording; and cart/shop
# outranked "about", so the checkout funnel beat the pages with an address.
#
# Legal-notice pages sit near the top because mentions légales / aviso legal /
# note legali / Impressum are legally REQUIRED to publish a contact address.
LINK_PRIORITY_KEYWORDS: dict[str, int] = {
    # contact
    "contact": 10, "contacto": 10, "contacte": 10, "contatti": 10,
    "contato": 10, "kontakt": 10, "contactez": 10, "nous-contacter": 10,
    "service-client": 10, "serviceclient": 10, "customer-service": 10,
    "atencion": 10, "atencion-al-cliente": 10,
    # publisher / legal notice — an address is mandatory on these across the EU
    "impressum": 9, "mentions-legales": 9, "mentionslegales": 9,
    "aviso-legal": 9, "note-legali": 9, "legal-notice": 9, "informacion-legal": 9,
    # about / who we are
    "about": 8, "sobre": 8, "nosotros": 8, "quienes-somos": 8,
    "qui-sommes-nous": 8, "nous-connaitre": 8, "chi-siamo": 8,
    "sobre-nos": 8, "a-propos": 8,
    # shop / cart / storefront — still above the shallow-path bonus so the
    # ecommerce classifier keeps seeing a shop page, but no longer ahead of the
    # pages that carry an address
    "cart": 7, "carrito": 7, "cesta": 7, "cistella": 7, "checkout": 7, "panier": 7,
    "tienda": 7, "botiga": 7, "shop": 7, "store": 7, "comprar": 7,
    "producto": 6, "productos": 6, "catalogo": 6, "catalogue": 6, "boutique": 6,
    "team": 6,
    # location / store-locator style subpages (generic keywords; a bare city
    # segment like "/barcelona/" won't match any of these — see SHALLOW_PATH_BONUS)
    "location": 6, "locations": 6, "ubicacion": 6, "ubicaciones": 6,
    "tiendas": 6, "sucursal": 6, "sucursales": 6, "store-locator": 6,
    # Last resort, above the shallow bonus only: a privacy policy names the data
    # controller, which on a one-shop site is the shop. Noisy (it also yields
    # agency and DPO addresses), so nothing else should lose a slot to it.
    "privacy": 4, "politique-de-confidentialite": 4, "privacidad": 4, "datenschutz": 4,
}
SHALLOW_PATH_BONUS = 3  # generic fallback for unmatched single-segment paths

# --------------------------------------------------------------------------
# Social / link-in-bio handling
#
# Many florists' Google-Maps "website" is actually a social profile or a
# link-aggregator page, with the real contact email living there (in the
# bio/description) or on whatever external site the bio link points to.
# `is_social_url` detects these hosts; `crawl_social_site` renders them
# headlessly (they're all JS-heavy / often login-walled), runs the existing
# email extractors over the rendered content, and follows the first outbound
# "link in bio" it finds via the normal `crawl_site` pipeline, all within
# the same MAX_PAGES_PER_FLORIST budget.
# --------------------------------------------------------------------------

SOCIAL_HOSTNAMES = (
    "instagram.com", "facebook.com", "fb.me", "m.facebook.com",
    "tiktok.com", "x.com", "twitter.com", "threads.com", "threads.net",
    "linktr.ee", "linktree.com", "beacons.ai", "taplink.cc", "taplink.at",
    "campsite.bio", "bio.link", "lnk.bio", "solo.to", "milkshake.app", "carrd.co",
)

# Hosts that wrap an outbound link in a redirect/tracking URL, e.g. Instagram's
# `https://l.instagram.com/?u=<encoded target>&e=...`. Unwrapped so the real
# target gets crawled, not the redirect host itself.
REDIRECT_WRAPPER_HOSTNAMES = ("l.instagram.com", "l.facebook.com", "lm.facebook.com")

# Platform-owned corporate/help/policy/app-store links that show up in a
# social page's chrome (footer, nav) even when logged out — never the
# florist's actual "link in bio" target, so excluded from bio-link
# candidates the same way same-platform links are.
NON_BIO_LINK_HOSTNAMES = (
    "meta.com", "about.meta.com", "meta.ai", "help.instagram.com", "help.facebook.com",
    "privacycenter.instagram.com", "developers.facebook.com",
    "business.instagram.com", "business.facebook.com",
    "apps.apple.com", "play.google.com", "itunes.apple.com",
)

# Heuristics for an honest "rendered but blocked" note — not used to gate
# extraction, only to explain a null result in enrichment_notes.
LOGIN_WALL_MARKERS = (
    "log in to instagram",
    "you must log in",
    "login • instagram",
    "see posts, photos and more on facebook",
    "you'll need to log in",
    "sorry, this page isn't available",
)


def is_social_url(url: str | None) -> bool:
    """True if `url` points at a known social / link-in-bio host."""
    if not url:
        return False
    netloc = urlparse(url).netloc.lower().removeprefix("www.")
    return any(netloc == host or netloc.endswith("." + host) for host in SOCIAL_HOSTNAMES)


def _looks_login_walled(html: str | None) -> bool:
    """Best-effort signal that a rendered social page is blocked/empty
    (login wall, app-install teaser, etc.) — used only for an honest note.
    """
    if not html:
        return True
    lower = html.lower()
    return any(marker in lower for marker in LOGIN_WALL_MARKERS) or is_thin_page(html)


def _unwrap_redirect_link(url: str) -> str:
    """Unwrap known redirect-wrapper URLs (e.g. Instagram's `l.instagram.com`)
    to the real target they point to; returns `url` unchanged otherwise.
    """
    parsed = urlparse(url)
    netloc = parsed.netloc.lower().removeprefix("www.")
    if netloc in REDIRECT_WRAPPER_HOSTNAMES:
        target = parse_qs(parsed.query).get("u", [None])[0]
        if target:
            return unquote(target)
    return url


def extract_social_links(html: str, base_url: str) -> list[str]:
    """Links on `html` that point at a *social* host (e.g. an Instagram icon
    in a normal florist site's footer) — used as a last-resort fallback when
    the normal site crawl finds no email at all.
    """
    soup = BeautifulSoup(html, "html.parser")
    seen: set[str] = set()
    links: list[str] = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or href.startswith(SKIP_LINK_SCHEMES):
            continue
        absolute = urljoin(base_url, href)
        if not is_social_url(absolute):
            continue
        normalized = urlparse(absolute)._replace(fragment="").geturl()
        if normalized in seen:
            continue
        seen.add(normalized)
        links.append(normalized)
    return links


def extract_bio_link_candidates(html: str, base_url: str) -> list[str]:
    """External, non-social outbound links from a rendered social/link-in-bio
    page — the "link in bio" pointing at the florist's real site (or another
    aggregator), as opposed to internal platform-nav links (help, login,
    other profiles on the same platform).
    """
    soup = BeautifulSoup(html, "html.parser")
    seen: set[str] = set()
    links: list[str] = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or href.startswith(SKIP_LINK_SCHEMES):
            continue
        absolute = _unwrap_redirect_link(urljoin(base_url, href))
        parsed = urlparse(absolute)
        if parsed.scheme not in ("http", "https"):
            continue
        if is_social_url(absolute):
            continue  # internal nav / cross-links to other social platforms
        netloc = parsed.netloc.lower().removeprefix("www.")
        if any(netloc == host or netloc.endswith("." + host) for host in NON_BIO_LINK_HOSTNAMES):
            continue  # platform corporate/help/app-store chrome, not the real bio link
        if any(parsed.path.lower().endswith(ext) for ext in SKIP_LINK_EXTENSIONS):
            continue
        normalized = parsed._replace(fragment="").geturl()
        if normalized in seen:
            continue
        seen.add(normalized)
        links.append(normalized)
    return links

ECOMMERCE_PLATFORM_SIGNALS = [
    "shopify", "woocommerce", "magento", "bigcommerce", "prestashop",
    "squarespace-commerce", "sqs-commerce", "wix-stores", "wixstores", "ecwid",
]
ECOMMERCE_CART_SIGNALS = [
    "/cart", "/checkout", "add-to-cart", "addtocart", "add to cart",
    "carrito", "cesta", "cistella", "/comprar", "finalizar compra", "finalizar-compra",
    "add to basket", "afegir a la cistella", "añadir al carrito",
]
ECOMMERCE_SHOP_PATH_SIGNALS = ("/tienda", "/botiga", "/shop", "/store", "/producto", "/productos")
ECOMMERCE_NETWORK_MARKERS = [
    ("interflora", "interflora"),
    ("livingwithflowerseveryday", "interflora"),
    ("teleflora", "teleflora"),
]
# Signal keys that are, on their own, a strong-enough positive to call
# is_ecommerce=True without needing the Claude fallback.
STRONG_ECOMMERCE_SIGNAL_KEYS = {"platform", "cart_signal", "product_schema", "network_marker", "maps_online_order"}

# Local part adds Latin-1 Supplement + Latin Extended-A letters (À-ÖØ-öø-ÿĀ-ž) to
# a-zA-Z0-9 so genuine es/fr/it/de addresses with accented local parts (e.g.
# "concepciónperez@correo-demo.es") aren't silently truncated. Deliberately
# NOT \w/any-Unicode-letter — that also swallows adjacent CJK/Cyrillic/etc. text
# glued in front of a real ASCII email with no separator, trading one silent
# corruption for another. This POC's markets are Latin-script only.
EMAIL_REGEX = re.compile(r"[a-zA-Z0-9À-ÖØ-öø-ÿĀ-ž._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
MAILTO_REGEX = re.compile(r'mailto:([^"\'\s?>]+)', re.IGNORECASE)
OBFUSCATED_EMAIL_REGEX = re.compile(
    r"[a-zA-Z0-9À-ÖØ-öø-ÿĀ-ž._%+\-]+\s*(?:\(at\)|\[at\]|\bat\b)\s*[a-zA-Z0-9.\-]+\s*(?:\(dot\)|\[dot\]|\bdot\b)\s*[a-zA-Z]{2,}",
    re.IGNORECASE,
)
# Cloudflare's email obfuscation, which the "(at)/(dot)" patterns below cannot
# see. It rewrites an address to
#   <a href="/cdn-cgi/l/email-protection#<hex>" data-cfemail="<hex>">[email protected]</a>
# and decodes it in the browser with its own script. The hex is XOR'd against
# its own first byte, so reversing it needs no JS — which matters because this
# crawler doesn't run theirs, and without this the page just reads
# "[email protected]".
# KEEP IN STEP with ingest-worker/src/config.ts::CF_EMAIL_REGEX.
CF_EMAIL_REGEX = re.compile(
    r'(?:data-cfemail="|/cdn-cgi/l/email-protection#)([0-9a-fA-F]{4,})'
)

_DEOBFUSCATE_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\(at\)|\[at\]|\bat\b", re.IGNORECASE), "@"),
    (re.compile(r"\(dot\)|\[dot\]|\bdot\b", re.IGNORECASE), "."),
]
TEL_HREF_REGEX = re.compile(r'tel:([^"\'\s?>]+)', re.IGNORECASE)
# Click-to-chat WhatsApp links are a very common primary contact number for
# small local businesses (e.g. `https://api.whatsapp.com/send?phone=34...`
# or `https://wa.me/34...`) — often the ONLY phone number on the page.
WHATSAPP_PHONE_REGEX = re.compile(
    r"(?:wa\.me/|whatsapp\.com/send\?(?:[^\"'>\s]*&)?phone=)([0-9][0-9()+\-.\s]{6,20}[0-9])",
    re.IGNORECASE,
)
# Generic fallback sweep: broad enough for spaced/dotted/parenthesized/
# localized formats ("972 00 02 51", "+34 972.00.02.51", "(617) 267-5900"),
# but deliberately last-priority — it also matches plenty of non-phone
# digit runs (tracking IDs, timestamps, CSS pixel pairs), which is why
# `extract_candidate_phones` puts the tel:/JSON-LD/WhatsApp sources first so
# they survive the MAX_CANDIDATES cap.
PHONE_REGEX = re.compile(r"(\+?\(?\d[\d\-.\s()]{6,}\d\)?)")

SKIP_EMAIL_DOMAIN_SUFFIXES = ("wixsite.com", "sentry.io", "example.com", "godaddy.com")
SKIP_EMAIL_LOCAL_PREFIXES = ("noreply", "no-reply", "donotreply", "do-not-reply")

ABOUT_PATH_KEYWORDS = (
    "about", "sobre", "nosotros", "quienes-somos", "team", "impressum",
    "über-uns", "uber-uns",
)
# KEEP IN STEP with ingest-worker/src/config.ts::CONTACT_PATH_KEYWORDS. Same
# blind spot as above: 122 of 1000 emailless florists carried the note "No
# contact/about-style page content found", many of them French sites whose
# contact page is /service-client or /nous-connaitre.
CONTACT_PATH_KEYWORDS = (
    "contact", "contacto", "contacte", "contatti", "contato", "kontakt",
    "service-client", "serviceclient", "nous-contacter", "customer-service",
    "impressum", "mentions-legales", "aviso-legal", "note-legali", "legal-notice",
    "about", "nosotros", "quienes-somos", "qui-sommes-nous", "nous-connaitre",
    "chi-siamo", "sobre-nos", "a-propos",
)

MAX_CANDIDATES = 10


# --------------------------------------------------------------------------
# Fetching + headless rendering
# --------------------------------------------------------------------------


def is_thin_page(html: str | None) -> bool:
    """Heuristic for "this looks like a JS shell, not real content"."""
    if not html or len(html) < THIN_HTML_BYTES:
        return True
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(separator=" ", strip=True)
    links = soup.find_all("a", href=True)
    return len(text) < THIN_TEXT_CHARS or len(links) == 0


async def fetch_static(http_client: httpx.AsyncClient, url: str) -> str | None:
    """Plain HTTP GET, body capped at MAX_PAGE_BYTES (streamed, so an
    oversized response is never fully buffered — see MAX_PAGE_BYTES for why).
    Failures (timeout, DNS, 4xx/5xx) are swallowed — one bad URL should not
    fail the whole florist's enrichment. Truncation lands on an arbitrary
    byte boundary that can split a multi-byte character; errors="ignore"
    silently drops that dangling partial rather than corrupting the rest of
    the text with a replacement character.
    """
    try:
        async with http_client.stream(
            "GET", url, timeout=FETCH_TIMEOUT_SECONDS, follow_redirects=True
        ) as resp:
            if resp.status_code >= 400:
                return None
            chunks: list[bytes] = []
            received = 0
            async for chunk in resp.aiter_bytes():
                remaining = MAX_PAGE_BYTES - received
                if len(chunk) >= remaining:
                    if remaining > 0:
                        chunks.append(chunk[:remaining])
                    break
                chunks.append(chunk)
                received += len(chunk)
            text = b"".join(chunks).decode(resp.encoding or "utf-8", errors="ignore")
            return text or None
    except httpx.HTTPError:
        return None


async def render_page(browser, render_semaphore: asyncio.Semaphore, url: str) -> str | None:
    """Render `url` headlessly and return the resulting DOM's HTML, or None
    on any failure (no browser available, navigation timeout, crash, etc).
    """
    if browser is None:
        return None
    async with render_semaphore:
        context = None
        try:
            context = await browser.new_context(user_agent=USER_AGENT)
            page = await context.new_page()
            await page.goto(url, timeout=RENDER_TIMEOUT_MS, wait_until="domcontentloaded")
            await page.wait_for_timeout(500)  # brief settle for client-side rendering
            return await page.content()
        except Exception:
            return None
        finally:
            if context is not None:
                await context.close()


async def fetch_or_render(
    http_client: httpx.AsyncClient, browser, render_semaphore: asyncio.Semaphore, url: str
) -> tuple[str | None, str]:
    """Static fetch first; render headlessly if the static result is thin or
    missing. Returns (html, method) where method describes what worked.
    """
    static_html = await fetch_static(http_client, url)
    if static_html and not is_thin_page(static_html):
        return static_html, "static"
    rendered_html = await render_page(browser, render_semaphore, url)
    if rendered_html:
        return rendered_html, "rendered"
    if static_html:
        return static_html, "static-thin"
    return None, "unreachable"


# --------------------------------------------------------------------------
# Bounded internal-link crawl
# --------------------------------------------------------------------------


def collect_internal_links(html: str, base_url: str) -> list[str]:
    """Same-domain links from `html`, normalized (no fragment/query) and
    deduped, excluding non-navigable schemes and obvious asset files.
    """
    soup = BeautifulSoup(html, "html.parser")
    base_netloc = urlparse(base_url).netloc.lower().removeprefix("www.")
    base_normalized = urlparse(base_url)._replace(fragment="", query="").geturl().rstrip("/")

    seen: set[str] = set()
    links: list[str] = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or href.startswith(SKIP_LINK_SCHEMES):
            continue
        absolute = urljoin(base_url, href)
        parsed = urlparse(absolute)
        if parsed.scheme not in ("http", "https"):
            continue
        netloc = parsed.netloc.lower().removeprefix("www.")
        if netloc != base_netloc:
            continue
        if any(parsed.path.lower().endswith(ext) for ext in SKIP_LINK_EXTENSIONS):
            continue
        normalized = parsed._replace(fragment="", query="").geturl()
        if normalized.rstrip("/") == base_normalized or normalized in seen:
            continue
        seen.add(normalized)
        links.append(normalized)
    return links


def _score_link(url: str) -> int:
    path = urlparse(url).path.lower()
    score = 0
    for keyword, weight in LINK_PRIORITY_KEYWORDS.items():
        if keyword in path and weight > score:
            score = weight
    if score == 0:
        segments = [s for s in path.split("/") if s]
        if len(segments) == 1:
            score = SHALLOW_PATH_BONUS
    return score


def rank_links(links: list[str]) -> list[str]:
    """Highest-priority links first; stable order among ties."""
    return sorted(links, key=lambda url: -_score_link(url))


async def crawl_site(
    http_client: httpx.AsyncClient,
    browser,
    render_semaphore: asyncio.Semaphore,
    website_url: str,
    max_pages: int = MAX_PAGES_PER_FLORIST,
    follow_social_fallback: bool = True,
) -> tuple[dict[str, str], list[str]]:
    """Fetch the homepage (rendering it if it's a thin shell), then a
    prioritized, capped set of internal subpages. Returns (pages, notes).

    `max_pages` lets callers share the overall MAX_PAGES_PER_FLORIST budget
    across a chain of crawls (e.g. a social page's link-in-bio target gets
    whatever budget the social crawl has left). `follow_social_fallback`
    gates the last-resort "no email found -> try a social link discovered on
    this site" step (see below); nested calls made *from* that fallback (and
    from `crawl_social_site`) pass `follow_social_fallback=False` so the
    social <-> site handoff can only happen once per florist, never loop.
    """
    notes: list[str] = []
    pages: dict[str, str] = {}
    methods: dict[str, str] = {}

    if max_pages <= 0:
        return pages, notes

    home_html, home_method = await fetch_or_render(http_client, browser, render_semaphore, website_url)
    if home_html is None:
        notes.append(f"Homepage {website_url} was unreachable (static and headless both failed).")
        return pages, notes
    pages[website_url] = home_html
    methods[website_url] = home_method

    candidates = rank_links(collect_internal_links(home_html, website_url))
    budget = max_pages - 1
    for link in candidates[:budget]:
        html, method = await fetch_or_render(http_client, browser, render_semaphore, link)
        if html:
            pages[link] = html
            methods[link] = method

    notes.append(
        f"Crawled {len(pages)} page(s) (cap {max_pages}): "
        + ", ".join(f"{url} [{method}]" for url, method in methods.items())
    )

    # Escalation: nothing rendered yet and no signal found anywhere -> force
    # a headless render of the homepage as a last resort (covers pages that
    # aren't "thin" by our byte/text heuristic but still hide their real
    # contact/shop content behind client-side JS we didn't detect).
    already_rendered = any(m == "rendered" for m in methods.values())
    if not already_rendered:
        has_email_signal = bool(extract_candidate_emails(pages))
        has_phone_signal = bool(extract_candidate_phones(pages))
        has_ecommerce_signal = bool(detect_ecommerce_signals(pages))
        if not has_email_signal and not has_phone_signal and not has_ecommerce_signal:
            rendered_home = await render_page(browser, render_semaphore, website_url)
            if rendered_home and rendered_home != home_html:
                pages[website_url] = rendered_home
                methods[website_url] = "rendered (escalated: no signals found statically)"
                notes.append("No signals found in static content — escalated homepage to headless render.")
                remaining_budget = max_pages - len(pages)
                if remaining_budget > 0:
                    extra_links = [
                        link for link in rank_links(collect_internal_links(rendered_home, website_url))
                        if link not in pages
                    ]
                    for link in extra_links[:remaining_budget]:
                        html, method = await fetch_or_render(http_client, browser, render_semaphore, link)
                        if html:
                            pages[link] = html
                            methods[link] = method
                    if extra_links[:remaining_budget]:
                        notes.append(
                            f"Fetched {min(len(extra_links), remaining_budget)} additional page(s) "
                            "from the rendered homepage's nav."
                        )

    # Last-resort social fallback: the site itself yielded no email, but it
    # links out to a social profile (e.g. an Instagram icon in the footer) —
    # try that, since the email sometimes lives there instead. Bounded to one
    # hop (`follow_social_fallback=False` downstream) and to whatever page
    # budget remains.
    if follow_social_fallback and len(pages) < max_pages and not extract_candidate_emails(pages):
        social_links = []
        for url, html in pages.items():
            for link in extract_social_links(html, url):
                if link not in social_links:
                    social_links.append(link)
        if social_links:
            social_link = social_links[0]
            notes.append(f"No email found on the site — trying social link discovered on the page: {social_link}.")
            social_pages, social_notes = await crawl_social_site(
                http_client, browser, render_semaphore, social_link, max_pages=max_pages - len(pages)
            )
            pages.update(social_pages)
            notes.extend(social_notes)

    return pages, notes


async def crawl_social_site(
    http_client: httpx.AsyncClient,
    browser,
    render_semaphore: asyncio.Semaphore,
    social_url: str,
    max_pages: int = MAX_PAGES_PER_FLORIST,
) -> tuple[dict[str, str], list[str]]:
    """Headless-render a social / link-in-bio profile (`social_url`) and run
    the normal extractors over the rendered bio/meta/visible text, then
    follow the first outbound "link in bio" it finds (the real site, or
    another aggregator) via the normal `crawl_site` pipeline. Returns
    (pages, notes); best-effort and honest — a login-walled or blocked page
    is recorded in `notes` and simply yields no pages/candidates rather than
    fabricating anything.
    """
    notes: list[str] = []
    pages: dict[str, str] = {}

    if max_pages <= 0:
        return pages, notes

    rendered_html = await render_page(browser, render_semaphore, social_url)
    if rendered_html is None:
        notes.append(f"{social_url} is a social/link-in-bio profile; headless render failed (unreachable or blocked).")
        return pages, notes

    pages[social_url] = rendered_html
    if _looks_login_walled(rendered_html):
        notes.append(
            f"{social_url} is a social profile; rendered but appears login-walled/blocked "
            "— bio content may be incomplete."
        )
    else:
        notes.append(f"{social_url} is a social profile; rendered successfully.")

    remaining_budget = max_pages - len(pages)
    if remaining_budget <= 0:
        return pages, notes

    bio_links = extract_bio_link_candidates(rendered_html, social_url)
    if not bio_links:
        notes.append(f"No outbound link-in-bio found on {social_url}.")
        return pages, notes

    bio_link = bio_links[0]
    notes.append(f"Following link-in-bio target from {social_url}: {bio_link}.")
    bio_pages, bio_notes = await crawl_site(
        http_client, browser, render_semaphore, bio_link, max_pages=remaining_budget, follow_social_fallback=False
    )
    pages.update(bio_pages)
    notes.extend(bio_notes)
    if not bio_pages:
        notes.append(f"Link-in-bio target {bio_link} was unreachable.")

    return pages, notes


# --------------------------------------------------------------------------
# Rule-based detection
# --------------------------------------------------------------------------


def detect_ecommerce_signals(pages: dict[str, str]) -> dict[str, Any]:
    """Search collected page content + URLs for platform/cart/product-schema/
    network-marker signals. Returns an empty dict when nothing matched.

    Social-platform pages themselves (Instagram, Facebook, etc.) are
    excluded from the text scanned here: their own scripts/config blobs
    reference all sorts of third-party integration names (observed:
    Instagram embeds internal flags like "shopify_app_bridge") that are
    about the platform, not about whether *this florist* runs a Shopify
    store — a false positive that would otherwise bypass the Claude
    fallback via `STRONG_ECOMMERCE_SIGNAL_KEYS`. A followed link-in-bio
    target's own page content is still scanned normally.
    """
    signals: dict[str, Any] = {}
    rule_pages = {url: html for url, html in pages.items() if not is_social_url(url)}
    combined = "\n".join(rule_pages.values()).lower()

    for platform in ECOMMERCE_PLATFORM_SIGNALS:
        if platform in combined:
            signals["platform"] = platform
            break

    for cart_signal in ECOMMERCE_CART_SIGNALS:
        if cart_signal in combined:
            signals["cart_signal"] = cart_signal
            break

    if "schema.org/product" in combined:
        signals["product_schema"] = True

    for marker_text, network in ECOMMERCE_NETWORK_MARKERS:
        if marker_text in combined:
            signals["network_marker"] = network
            break

    if any(any(shop_kw in url.lower() for shop_kw in ECOMMERCE_SHOP_PATH_SIGNALS) for url in rule_pages):
        signals["shop_page_crawled"] = True

    return signals


def decode_cloudflare_email(hex_payload: str) -> str | None:
    """Reverses Cloudflare's email obfuscation (CF_EMAIL_REGEX).

    The payload is hex whose FIRST byte is the XOR key for every byte after it.
    That is the whole algorithm — the same one Cloudflare's client-side snippet
    runs, reimplemented because this crawler doesn't execute it.

    Returns None for anything that doesn't decode to something email-shaped,
    rather than letting mojibake through as a candidate.
    """
    if len(hex_payload) < 4 or len(hex_payload) % 2:
        return None
    try:
        raw = bytes.fromhex(hex_payload)
    except ValueError:
        return None
    key, body = raw[0], raw[1:]
    decoded = "".join(chr(byte ^ key) for byte in body)
    return decoded if EMAIL_REGEX.fullmatch(decoded) else None


def deobfuscate_entity_encoded_email(html: str) -> str:
    """Reverses WordPress core's `antispambot()` email cloaking: the address
    spelled out as per-character HTML numeric entities (`&#109;` / `&#x6d;`,
    mixed), sometimes with the href target ALSO percent-encoded underneath
    that (`antispambot()` alternates forms per character — observed on
    blumendemo.ch and flori-demo.ro). Both render plainly to a human and contain
    no literal "@" for a raw-html regex to find. A no-op string in, string
    out — safe to run unconditionally and re-scan with the normal regexes.
    """
    return unquote(unescape_html_entities(html))


def _deobfuscate(span: str) -> str:
    normalized = span
    for pattern, repl in _DEOBFUSCATE_PATTERNS:
        normalized = pattern.sub(repl, normalized)
    return re.sub(r"\s+", "", normalized)


def extract_candidate_emails(pages: dict[str, str]) -> list[str]:
    """Emails from plain-text regex, `mailto:` hrefs, JSON-LD/structured
    data, and de-obfuscated text (`(at)`/`[at]`/` at `, ` dot `), merged and
    filtered against known noreply/CDN/builder-subdomain junk.
    """
    found: list[str] = []

    def add_all(candidates: list[str]) -> None:
        for candidate in candidates:
            lower = candidate.lower()
            if any(lower.endswith(suffix) for suffix in SKIP_EMAIL_DOMAIN_SUFFIXES):
                continue
            if any(lower.startswith(prefix) for prefix in SKIP_EMAIL_LOCAL_PREFIXES):
                continue
            # A retina-asset filename ("shadow@2x.png", "logo@2x.jpg") is
            # "local@domain.tld"-shaped enough to pass EMAIL_REGEX — reuse the
            # same extension list link-collection already skips for the same
            # reason (real found case: perfume-demo.net's CSS).
            if any(lower.endswith(ext) for ext in SKIP_LINK_EXTENSIONS):
                continue
            if candidate not in found:
                found.append(candidate)

    for html in pages.values():
        add_all(EMAIL_REGEX.findall(html))
        add_all(match.split("?")[0].strip() for match in MAILTO_REGEX.findall(html))
        # Cloudflare-obfuscated addresses, off the RAW html: by the time the
        # page is text this reads "[email protected]" and there is nothing left.
        add_all(
            email
            for email in (decode_cloudflare_email(h) for h in CF_EMAIL_REGEX.findall(html))
            if email
        )
        # WordPress antispambot()-style cloaking (see deobfuscate_entity_encoded_email).
        # Gated on "&#" so the decode+re-scan only runs on pages that actually
        # carry numeric entities, not every page (which nearly all do, via
        # &amp;/&nbsp;, but essentially none of which cloak an email this way).
        if "&#" in html:
            deobfuscated_html = deobfuscate_entity_encoded_email(html)
            add_all(EMAIL_REGEX.findall(deobfuscated_html))
            add_all(match.split("?")[0].strip() for match in MAILTO_REGEX.findall(deobfuscated_html))

    for html in pages.values():
        soup = BeautifulSoup(html, "html.parser")
        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string or "")
            except (json.JSONDecodeError, TypeError):
                continue
            add_all(_find_emails_in_json(data))

        text = soup.get_text(separator=" ")
        deobfuscated = [_deobfuscate(span) for span in OBFUSCATED_EMAIL_REGEX.findall(text)]
        add_all(email for email in deobfuscated if EMAIL_REGEX.fullmatch(email))

    return found[:MAX_CANDIDATES]


def _find_emails_in_json(obj: Any) -> list[str]:
    results: list[str] = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key.lower() == "email" and isinstance(value, str):
                results.append(value.replace("mailto:", "").strip())
            else:
                results.extend(_find_emails_in_json(value))
    elif isinstance(obj, list):
        for item in obj:
            results.extend(_find_emails_in_json(item))
    return results


def extract_candidate_phones(pages: dict[str, str]) -> list[str]:
    """Phone candidates from, in priority order, the most reliable sources
    first so they survive the `MAX_CANDIDATES` cap ahead of the noisy
    generic sweep: `tel:` hrefs (phone analog of `mailto:`), JSON-LD
    schema.org `telephone`, WhatsApp click-to-chat links, then a generic
    digit-run regex over the raw HTML (also matches plenty of non-phone
    digit blobs — tracking IDs, timestamps, CSS pixel pairs — hence last).
    """
    found: list[str] = []

    def add_all(candidates) -> None:
        for candidate in candidates:
            cleaned = candidate.strip()
            digit_count = len(re.sub(r"\D", "", cleaned))
            if 8 <= digit_count <= 15 and cleaned not in found:
                found.append(cleaned)

    for html in pages.values():
        add_all(match.split("?")[0].strip() for match in TEL_HREF_REGEX.findall(html))

    for html in pages.values():
        soup = BeautifulSoup(html, "html.parser")
        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string or "")
            except (json.JSONDecodeError, TypeError):
                continue
            add_all(_find_phones_in_json(data))

    for html in pages.values():
        add_all(WHATSAPP_PHONE_REGEX.findall(html))

    for html in pages.values():
        add_all(PHONE_REGEX.findall(html))

    return found[:MAX_CANDIDATES]


def _find_phones_in_json(obj: Any) -> list[str]:
    results: list[str] = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key.lower() in ("telephone", "phone") and isinstance(value, str):
                results.append(value.replace("tel:", "").strip())
            else:
                results.extend(_find_phones_in_json(value))
    elif isinstance(obj, list):
        for item in obj:
            results.extend(_find_phones_in_json(item))
    return results


def build_focused_context(
    pages: dict[str, str], candidates: list[str], window: int = 180, max_chars: int = 1600
) -> str:
    """A compact, high-signal context for candidate selection (workstream B).

    The email/phone candidates are already regex-extracted, so Claude only
    needs the *local* visible text around each to judge which is the genuine
    primary contact — not the whole raw HTML. This returns the visible text
    within +/-`window` chars of each candidate, joined and capped at
    `max_chars` (vs. the old raw `combined_html[:4000]`), cutting ~60-70% of
    the input tokens on those two calls. Falls back to the head of the visible
    text when no candidate is found in it (e.g. an email that lives only in a
    `mailto:` href, not the rendered text).
    """
    texts: list[str] = []
    for html in pages.values():
        soup = BeautifulSoup(html, "html.parser")
        texts.append(soup.get_text(separator=" ", strip=True))
    combined_text = " ".join(texts)

    snippets: list[str] = []
    for candidate in candidates:
        idx = combined_text.find(candidate)
        if idx == -1:
            continue
        start = max(0, idx - window)
        end = min(len(combined_text), idx + len(candidate) + window)
        snippets.append(combined_text[start:end])

    focused = " … ".join(snippets) if snippets else combined_text[:max_chars]
    return focused[:max_chars]


def extract_text_for_owner(pages: dict[str, str]) -> str:
    texts = []
    for url, html in pages.items():
        path = urlparse(url).path.lower()
        if any(keyword in path for keyword in ABOUT_PATH_KEYWORDS) or any(
            keyword in path for keyword in CONTACT_PATH_KEYWORDS
        ):
            soup = BeautifulSoup(html, "html.parser")
            texts.append(soup.get_text(separator=" ", strip=True)[:4000])
    return "\n\n".join(texts)[:8000]


# --------------------------------------------------------------------------
# Claude fallbacks (structured outputs via messages.parse)
# --------------------------------------------------------------------------


async def _parse(claude_client, max_tokens: int, prompt: str, output_format, call_type: str, tracker):
    """Run a blocking client.messages.parse(...) off the event loop, using the
    model routed for `call_type` and recording its usage into `tracker`."""
    model = MODEL_FOR_CALL[call_type]
    response = await asyncio.to_thread(
        claude_client.messages.parse,
        model=routed_model(model),
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
        output_format=output_format,
    )
    if tracker is not None:
        tracker.record(call_type, model, response)
    return response.parsed_output


async def classify_ecommerce(
    claude_client, cache: dict, combined_html: str, tracker
) -> EcommerceClassification:
    cache_key = ("ecommerce", combined_html[:6000])
    if cache_key in cache:
        return cache[cache_key]
    prompt = ECOMMERCE_CLASSIFICATION_PROMPT.format(html_excerpt=combined_html[:6000])
    result = await _parse(claude_client, 1024, prompt, EcommerceClassification, "ecommerce", tracker)
    cache[cache_key] = result
    return result


async def extract_email(
    claude_client, cache: dict, candidates: list[str], context: str, tracker
) -> EmailExtraction:
    cache_key = ("email", tuple(candidates), context[:4000])
    if cache_key in cache:
        return cache[cache_key]
    prompt = EMAIL_EXTRACTION_PROMPT.format(
        candidates="\n".join(candidates) or "(none found)", context=context[:4000]
    )
    result = await _parse(claude_client, 512, prompt, EmailExtraction, "email", tracker)
    cache[cache_key] = result
    return result


async def extract_phone(
    claude_client, cache: dict, candidates: list[str], context: str, tracker
) -> PhoneExtraction:
    cache_key = ("phone", tuple(candidates), context[:4000])
    if cache_key in cache:
        return cache[cache_key]
    prompt = PHONE_EXTRACTION_PROMPT.format(
        candidates="\n".join(candidates) or "(none found)", context=context[:4000]
    )
    result = await _parse(claude_client, 512, prompt, PhoneExtraction, "phone", tracker)
    cache[cache_key] = result
    return result


async def extract_owner_info(claude_client, cache: dict, text: str, tracker) -> OwnerInfo:
    cache_key = ("owner", text)
    if cache_key in cache:
        return cache[cache_key]
    prompt = OWNER_INFO_PROMPT.format(text=text)
    result = await _parse(claude_client, 256, prompt, OwnerInfo, "owner", tracker)
    cache[cache_key] = result
    return result


# --------------------------------------------------------------------------
# Per-florist orchestration
# --------------------------------------------------------------------------


async def enrich_florist(
    florist: dict,
    http_client: httpx.AsyncClient,
    browser,
    render_semaphore: asyncio.Semaphore,
    claude_client,
    claude_cache: dict,
    semaphore: asyncio.Semaphore,
    tracker,
) -> dict:
    website = florist.get("website_url")

    if not website:
        return {
            "has_website": False,
            "is_ecommerce": None,
            "ecommerce_signals": None,
            "email": None,
            "phone_web": None,
            "owner_name": None,
            "shop_highlight": None,
            "content_language": None,
            "enrichment_notes": "No website on Maps listing — skipped enrichment.",
        }

    async with semaphore:
        notes: list[str] = []
        if is_social_url(website):
            # The Maps listing's "website" is itself a social/link-in-bio
            # profile (e.g. Instagram) rather than a real site.
            pages, crawl_notes = await crawl_social_site(http_client, browser, render_semaphore, website)
        else:
            pages, crawl_notes = await crawl_site(http_client, browser, render_semaphore, website)
        notes.extend(crawl_notes)

        if not pages:
            return {
                "has_website": True,
                "is_ecommerce": None,
                "ecommerce_signals": None,
                "email": None,
                "phone_web": None,
                "owner_name": None,
                "shop_highlight": None,
                "content_language": None,
                "enrichment_notes": " ".join(notes),
            }

        combined_html = "\n".join(pages.values())

        # --- Ecommerce detection: Maps signal + broadened rules, Claude fallback ---
        signals = detect_ecommerce_signals(pages)
        maps_online_order = florist.get("maps_online_order")
        if maps_online_order:
            signals["maps_online_order"] = True

        is_ecommerce: bool | None
        if any(key in signals for key in STRONG_ECOMMERCE_SIGNAL_KEYS):
            is_ecommerce = True
            notes.append(f"Ecommerce signals matched via Maps/rules: {signals}.")
        else:
            try:
                classification = await classify_ecommerce(claude_client, claude_cache, combined_html, tracker)
            except Exception as exc:  # noqa: BLE001 - one florist's Claude failure must not abort the batch
                is_ecommerce = None
                notes.append(f"No strong rule/Maps ecommerce signals found; Claude classification failed ({exc!r}).")
            else:
                is_ecommerce = classification.is_ecommerce
                signals["llm_confidence"] = classification.confidence
                signals["llm_reasoning"] = classification.reasoning
                notes.append(
                    "No strong rule/Maps ecommerce signals found; Claude classified "
                    f"is_ecommerce={classification.is_ecommerce} "
                    f"(confidence={classification.confidence:.2f})."
                )

        # --- Email extraction ---
        email_candidates = extract_candidate_emails(pages)
        email = None
        if email_candidates:
            try:
                email_context = build_focused_context(pages, email_candidates)
                email_result = await extract_email(claude_client, claude_cache, email_candidates, email_context, tracker)
            except Exception as exc:  # noqa: BLE001
                # An outage is not a finding. Recording it as one is what left
                # 1,065 rows whose notes talk about billing and whose email is
                # null, indistinguishable downstream from "we looked and there
                # was nothing there".
                if is_llm_outage(exc):
                    raise LlmOutage(str(exc)) from exc
                notes.append(
                    f"{len(email_candidates)} email candidate(s) found; Claude extraction failed ({exc!r})."
                )
            else:
                email = email_result.email
                notes.append(
                    f"{len(email_candidates)} email candidate(s) found; Claude selected "
                    f"{email or 'none (no genuine primary email)'} "
                    f"(confidence={email_result.confidence:.2f})."
                )
        else:
            notes.append("No email candidates found (regex, mailto:, JSON-LD, or de-obfuscation).")

        # --- Phone extraction ---
        phone_candidates = extract_candidate_phones(pages)
        phone_web = None
        if phone_candidates:
            try:
                phone_context = build_focused_context(pages, phone_candidates)
                phone_result = await extract_phone(claude_client, claude_cache, phone_candidates, phone_context, tracker)
            except Exception as exc:  # noqa: BLE001
                if is_llm_outage(exc):  # see the email leg
                    raise LlmOutage(str(exc)) from exc
                notes.append(
                    f"{len(phone_candidates)} phone candidate(s) found; Claude extraction failed ({exc!r})."
                )
            else:
                phone_web = phone_result.phone
                notes.append(
                    f"{len(phone_candidates)} phone candidate(s) found; Claude selected "
                    f"{phone_web or 'none (no genuine primary phone)'} "
                    f"(confidence={phone_result.confidence:.2f})."
                )
        else:
            notes.append("No phone candidates found via regex.")

        # --- Owner info: name, distinctive highlight, content language ---
        owner_text = extract_text_for_owner(pages)
        owner_name = None
        shop_highlight = None
        content_language = None
        if owner_text:
            try:
                owner_info = await extract_owner_info(claude_client, claude_cache, owner_text, tracker)
            except Exception as exc:  # noqa: BLE001
                if is_llm_outage(exc):  # see the email leg
                    raise LlmOutage(str(exc)) from exc
                notes.append(f"Owner-info extraction failed ({exc!r}).")
            else:
                owner_name = owner_info.owner_name
                shop_highlight = owner_info.shop_highlight
                content_language = owner_info.content_language
                notes.append(
                    f"Owner/founder name: {owner_name or 'not clearly identifiable'}. "
                    f"Shop highlight: {shop_highlight or 'none'}. "
                    f"Content language: {content_language or 'undetermined'}."
                )
        else:
            notes.append("No contact/about-style page content found for owner-info extraction.")

        return {
            "has_website": True,
            "is_ecommerce": is_ecommerce,
            "ecommerce_signals": signals,
            "email": email,
            "phone_web": phone_web,
            "owner_name": owner_name,
            "shop_highlight": shop_highlight,
            "content_language": content_language,
            "enrichment_notes": " ".join(notes),
        }


# --------------------------------------------------------------------------
# LLM outage vs. one call going wrong
# --------------------------------------------------------------------------
# KEEP IN STEP with ingest-worker/src/openrouter.ts::isLlmOutage.
#
# The distinction decides whether per-florist isolation helps or hurts. A broken
# site or a model returning nonsense: isolate it, skip the florist, carry on. An
# exhausted or rejected key is not isolable — the next florist fails identically,
# and the run's only achievement is to overwrite a city with empty enrichments
# and a note about billing.
#
# 1,065 florists still carry "Please go to Plans & Billing to upgrade or
# purchase credits" in enrichment_notes, each with a null email, from a run that
# kept going.

#: Statuses meaning "every call after this one fails too".
_OUTAGE_STATUS = {401, 402, 403}
#: Text fallback for the same condition under a status that doesn't say so.
#: Anthropic returned the 2026-08-06 exhaustion as a plain 400, which a status
#: check alone waves through as an ordinary bad request.
_OUTAGE_TEXT = ("credit balance is too low", "insufficient credit", "quota exceeded")


def is_llm_outage(exc: BaseException) -> bool:
    """Is this the account being down, rather than this one call going wrong?"""
    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and status in _OUTAGE_STATUS:
        return True
    text = str(exc).lower()
    return any(marker in text for marker in _OUTAGE_TEXT)


class LlmOutage(RuntimeError):
    """Raised out of enrichment when the LLM account itself is unavailable, so
    the caller can stop the run instead of spoiling every remaining row."""


_FAILED_ENRICHMENT: dict = {
    "has_website": True,
    "is_ecommerce": None,
    "ecommerce_signals": None,
    "email": None,
    "phone_web": None,
    "owner_name": None,
    "shop_highlight": None,
    "content_language": None,
    "enrichment_notes": "Enrichment raised an unexpected error and was skipped for this florist.",
}


async def enrich_all(florists: list[dict], claude_client, tracker=None, on_done=None) -> list[dict]:
    """Enrich every florist concurrently (bounded by MAX_CONCURRENT_ENRICHMENTS,
    with headless rendering separately bounded by MAX_CONCURRENT_RENDERS).
    Returns a list of enrichment dicts in the same order as `florists`.

    `on_done`, if given, is `async (florist: dict, enrichment: dict) -> None`
    and fires as each florist's enrichment completes (inside the per-florist
    task, not at the final `gather` barrier) — used by the caller to persist
    progressively instead of waiting for the whole batch.

    A single Chromium instance is launched once and reused for the whole
    batch. If Playwright/Chromium isn't available (e.g. `playwright install
    chromium` was never run), rendering is skipped and enrichment degrades
    gracefully to static-fetch-only — this must never abort the whole run.

    Per-florist Claude-call failures are already caught and recorded inside
    `enrich_florist`. `return_exceptions=True` here is a second line of
    defense: any other unexpected error (e.g. a bug in a rule-based
    helper) degrades that one florist to a safe "unknown" result instead
    of aborting every other florist's enrichment via `asyncio.gather`.
    """
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_ENRICHMENTS)
    render_semaphore = asyncio.Semaphore(MAX_CONCURRENT_RENDERS)
    claude_cache: dict = {}
    headers = {"User-Agent": USER_AGENT}

    browser = None
    playwright_ctx = None
    try:
        from playwright.async_api import async_playwright

        playwright_ctx = await async_playwright().start()
        browser = await playwright_ctx.chromium.launch()
    except Exception as exc:  # noqa: BLE001 - missing/broken Playwright must not abort ingest
        print(
            f"[enrich] Headless rendering unavailable ({exc!r}); "
            "falling back to static-fetch-only enrichment for this run.",
            file=sys.stderr,
        )
        browser = None

    try:
        async with httpx.AsyncClient(headers=headers) as http_client:
            async def _run(f):
                enrichment = await enrich_florist(
                    f, http_client, browser, render_semaphore, claude_client, claude_cache, semaphore, tracker
                )
                if on_done is not None:
                    # Fires as THIS florist finishes (not at the barrier), so
                    # persistence lands progressively. An on_done failure is
                    # captured by return_exceptions below; the florist's bare
                    # row (already persisted) simply stays as-is.
                    await on_done(f, enrichment)
                return enrichment

            tasks = [_run(f) for f in florists]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            # Run-level circuit breaker. gather(return_exceptions=True) exists so
            # ONE florist can't fail the batch, which is right for a broken site
            # and wrong for a dead key: every florist left would fail the same
            # way, and the run would finish "successfully" having replaced a
            # city with empty enrichments. Fail loudly instead — the bare rows
            # persisted by on_done keep their Maps data and stay eligible for
            # repair mode, which is what it is for.
            outage = next((r for r in results if isinstance(r, LlmOutage)), None)
            if outage is not None:
                raise LlmOutage(
                    "LLM unavailable - enrichment stopped to avoid overwriting the rest of the "
                    f"batch with empty results. Top up or fix the key, then re-run. ({outage})"
                )
    finally:
        if browser is not None:
            await browser.close()
        if playwright_ctx is not None:
            await playwright_ctx.stop()

    return [
        {**_FAILED_ENRICHMENT, "enrichment_notes": f"{_FAILED_ENRICHMENT['enrichment_notes']} ({result!r})"}
        if isinstance(result, BaseException)
        else result
        for result in results
    ]
