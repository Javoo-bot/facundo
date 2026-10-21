"""Sanity assertions for email extraction against Unicode local parts (real
case: a florist's genuine email, concepciónperez@correo-demo.es, was
being silently mangled by an ASCII-only regex before reaching Claude or the
DB). Run: uv run python test_email_regex.py"""
from enrich import EMAIL_REGEX, OBFUSCATED_EMAIL_REGEX, extract_candidate_emails


def test_email_regex_accepts_unicode_local_part():
    assert EMAIL_REGEX.fullmatch("concepciónperez@correo-demo.es")


def test_email_regex_findall_does_not_truncate_unicode_local_part():
    html = "<p>Contact: concepciónperez@correo-demo.es for more info</p>"
    assert EMAIL_REGEX.findall(html) == ["concepciónperez@correo-demo.es"]


def test_obfuscated_email_regex_accepts_unicode_local_part():
    text = "concepciónperez (at) correo-demo (dot) es"
    assert OBFUSCATED_EMAIL_REGEX.fullmatch(text)


def test_extract_candidate_emails_preserves_unicode_local_part():
    pages = {"https://example.com": "<p>Email: concepciónperez@correo-demo.es</p>"}
    assert extract_candidate_emails(pages) == ["concepciónperez@correo-demo.es"]


def test_extract_candidate_emails_still_works_for_plain_ascii():
    pages = {"https://florshop-demo.com": "<p>Email: hello@florshop-demo.com</p>"}
    assert extract_candidate_emails(pages) == ["hello@florshop-demo.com"]


def test_email_regex_does_not_swallow_adjacent_cjk_text():
    # A widened-to-any-Unicode-letter class would pull "先生" (no separator) into
    # the local part — the same silent-corruption failure mode this fix targets,
    # just triggered by a different script. The extraction scope here is Latin
    # (the POC's es/fr/it/de markets), not "every Unicode letter."
    html = "<p>先生contact@example-shop.com</p>"
    assert EMAIL_REGEX.findall(html) == ["contact@example-shop.com"]


def test_email_regex_does_not_swallow_adjacent_cyrillic_text():
    html = "<p>Приветivan@example-shop.com</p>"
    assert EMAIL_REGEX.findall(html) == ["ivan@example-shop.com"]




# --- Cloudflare email obfuscation -------------------------------------------
# Added 2026-08-11. chaine-fleurs.com/content/18-service-client shows its address
# plainly to a human; to us the page read "[email protected]" and we stored
# nothing. Cloudflare hides it in an attribute and decodes it with JS we don't
# run. KEEP IN STEP with ingest-worker/test/extractors.test.ts.
def test_decode_cloudflare_email_reverses_the_real_payload():
    from enrich import decode_cloudflare_email

    assert (
        decode_cloudflare_email("b3d0dcddc7d2d0c7f3d0dbd2daddd69ed5dfd6c6c1c09dd0dcde")
        == "contact@chaine-fleurs.com"
    )


def test_decode_cloudflare_email_returns_none_for_junk():
    from enrich import decode_cloudflare_email

    assert decode_cloudflare_email("00") is None        # too short
    assert decode_cloudflare_email("abc") is None       # odd length
    assert decode_cloudflare_email("zzzz") is None      # not hex
    assert decode_cloudflare_email("deadbeef") is None  # decodes, but not email-shaped


def test_extract_candidate_emails_reads_a_cfemail_attribute():
    html = (
        '<a href="/cdn-cgi/l/email-protection" class="__cf_email__" '
        'data-cfemail="b3d0dcddc7d2d0c7f3d0dbd2daddd69ed5dfd6c6c1c09dd0dcde">'
        "[email&#160;protected]</a>"
    )
    assert extract_candidate_emails({"https://x.test/": html}) == ["contact@chaine-fleurs.com"]


def test_extract_candidate_emails_reads_the_email_protection_href():
    html = '<a href="/cdn-cgi/l/email-protection#b3d0dcddc7d2d0c7f3d0dbd2daddd69ed5dfd6c6c1c09dd0dcde">x</a>'
    assert extract_candidate_emails({"https://x.test/": html}) == ["contact@chaine-fleurs.com"]


# --- WordPress antispambot()-style entity/percent obfuscation --------------
# Added 2026-09-01. blumendemo.ch and flori-demo.ro spell the address out as
# per-character HTML numeric entities (WordPress core's antispambot()), and
# flori-demo.ro additionally percent-encodes the href target underneath that —
# both render plainly to a human ("E-Mail: info@blumendemo.ch") and read as
# nothing to a raw-html regex, since there's no literal "@" in the source.
# KEEP IN STEP with ingest-worker/test/extractors.test.ts.
def test_extract_candidate_emails_reads_numeric_entity_obfuscation():
    # The real payload from blumendemo.ch/kontakt.html.
    html = (
        '<a href="&#109;&#97;&#105;&#108;&#116;&#111;&#58;&#105;&#x6E;&#102;&#x6F;'
        '&#64;&#x62;&#108;&#x75;&#109;&#x65;&#110;&#x64;&#101;&#x6D;&#111;&#46;&#x63;&#104;" '
        'class="email">&#105;&#x6E;&#102;&#x6F;&#64;&#x62;&#108;&#x75;&#109;&#x65;'
        '&#110;&#x64;&#101;&#x6D;&#111;&#46;&#x63;&#104;</a>'
    )
    assert extract_candidate_emails({"https://blumendemo.ch/": html}) == ["info@blumendemo.ch"]


def test_extract_candidate_emails_reads_entity_plus_percent_obfuscation():
    # The real payload from flori-demo.ro/contact: entities wrap the "mailto:"
    # prefix, percent-encoding wraps the address itself underneath that.
    html = (
        '<a href="&#109;&#97;&#105;&#108;&#116;&#111;&#58;%6f%66%66%69%63%65@'
        '%66%6c%6f%72%69%2d%64%65%6d%6f.%72%6f">'
        '&#x6f;&#x66;&#x66;&#x69;&#x63;&#x65;&#x40;&#x66;&#x6c;'
        '&#x6f;&#x72;&#x69;&#x2d;&#x64;&#x65;&#x6d;&#x6f;&#x2e;&#x72;&#x6f;</a>'
    )
    assert extract_candidate_emails({"https://flori-demo.ro/": html}) == ["office@flori-demo.ro"]


def test_extract_candidate_emails_entity_decode_does_not_corrupt_plain_pages():
    # Every page has SOME entities (&nbsp;, &amp; in URLs) — the decode pass
    # must not introduce garbage candidates on pages with no cloaked email.
    html = "<p>Contact us &amp; visit&nbsp;our shop. Email: hello@florshop-demo.com</p>"
    assert extract_candidate_emails({"https://florshop-demo.com/": html}) == ["hello@florshop-demo.com"]


# --- retina-asset-filename false positives ----------------------------------
# Added 2026-09-02. perfume-demo.net's CSS holds "shadow@2x.png" (the
# name@2x.png / name@3x.jpg convention for retina image assets), which is
# "local@domain.tld"-shaped enough to pass EMAIL_REGEX. It never reached a
# stored `email` (Claude's selection always filtered it), but it's still
# noise in the candidate list sent to Claude. KEEP IN STEP with
# ingest-worker/test/extractors.test.ts.
def test_extract_candidate_emails_skips_retina_asset_filenames():
    html = "<style>.icon{background:url(shadow@2x.png)}</style><p>Email: hello@florshop-demo.com</p>"
    assert extract_candidate_emails({"https://florshop-demo.com/": html}) == ["hello@florshop-demo.com"]


# --- crawl targeting --------------------------------------------------------
def test_contact_and_legal_pages_outrank_the_cart():
    """The chaine-fleurs regression, with that site's real URLs: all three pages
    holding an address scored 0 and lost their slot to the cart and the login."""
    from enrich import _score_link

    assert _score_link("https://www.chaine-fleurs.com/content/18-service-client") > _score_link(
        "https://www.chaine-fleurs.com/panier"
    )
    assert _score_link("https://www.chaine-fleurs.com/content/12-mentions-legales") > _score_link(
        "https://www.chaine-fleurs.com/mon-compte"
    )
    assert _score_link("https://www.chaine-fleurs.com/content/13-nous-connaitre") > _score_link(
        "https://www.chaine-fleurs.com/95-notre-collection-de-bouquets-2026"
    )


# --- LLM outage vs. one call going wrong ------------------------------------
# KEEP IN STEP with ingest-worker/test/openrouter.test.ts.
def test_is_llm_outage_recognises_a_dead_account():
    from enrich import is_llm_outage

    class Status(Exception):
        def __init__(self, status_code):
            super().__init__(f"http {status_code}")
            self.status_code = status_code

    for status in (401, 402, 403):
        assert is_llm_outage(Status(status)), status


def test_is_llm_outage_catches_the_2026_08_06_shape():
    """Anthropic returned credit exhaustion as a plain 400, which a status check
    alone waves through as an ordinary bad request. 1,065 rows carry this text."""
    from enrich import is_llm_outage

    exc = Exception(
        "Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', "
        "'message': 'Your credit balance is too low to access the Anthropic API. "
        "Please go to Plans & Billing to upgrade or purchase credits.'}}"
    )
    assert is_llm_outage(exc)


def test_is_llm_outage_leaves_ordinary_failures_isolable():
    """The ones per-florist isolation exists for: skip the florist, keep the run."""
    from enrich import is_llm_outage

    class Status(Exception):
        def __init__(self, status_code, msg="boom"):
            super().__init__(msg)
            self.status_code = status_code

    assert not is_llm_outage(Status(400, "malformed tool call"))
    assert not is_llm_outage(Status(429, "slow down"))
    assert not is_llm_outage(Status(500, "upstream boom"))
    assert not is_llm_outage(Exception("socket hang up"))



if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all email regex tests passed")
