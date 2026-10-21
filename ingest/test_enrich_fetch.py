"""Sanity assertions for fetch_static's page-size cap (2026-09-04).
Run: uv run python test_enrich_fetch.py

Added after a real Cloudflare Workflow OOM traced to flowstore.co.il, a Wix
page-builder site whose homepage alone is 1.15MB of HTML — crawl_site fetches
up to MAX_PAGES_PER_FLORIST of a site's pages, and this pipeline holds the
full text of each in memory at once. KEEP IN STEP with
ingest-worker/test/enrich.test.ts's readBodyCapped tests.
"""
import asyncio

import httpx

from enrich import MAX_PAGE_BYTES, fetch_static


def _client_for(body: bytes, content_type: str = "text/html; charset=utf-8") -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, headers={"content-type": content_type})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def _run(coro):
    return await coro


def test_returns_full_body_when_under_the_cap():
    async def go():
        async with _client_for(b"hello world") as client:
            return await fetch_static(client, "https://x.test/")

    assert asyncio.run(go()) == "hello world"


def test_truncates_a_body_larger_than_the_cap():
    big = b"x" * 2_000_000

    async def go():
        async with _client_for(big) as client:
            return await fetch_static(client, "https://x.test/")

    result = asyncio.run(go())
    assert result is not None
    assert len(result) < len(big)
    assert len(result) > 0


def test_empty_body_returns_none():
    async def go():
        async with _client_for(b"") as client:
            return await fetch_static(client, "https://x.test/")

    assert asyncio.run(go()) is None


def test_does_not_crash_on_multibyte_content_straddling_the_cap_boundary():
    # Hebrew (3-byte UTF-8 chars, matching the real failing case's locale),
    # padded well past MAX_PAGE_BYTES so a naive byte-slice lands mid-character.
    hebrew = ("פרחים " * 300_000).encode("utf-8")

    async def go():
        async with _client_for(hebrew, "text/html; charset=utf-8") as client:
            return await fetch_static(client, "https://x.test/")

    result = asyncio.run(go())
    assert result is not None
    assert len(result) > 0
    # errors="ignore" drops a dangling partial byte rather than raising or
    # inserting a replacement character.
    assert "�" not in result


def test_4xx_response_returns_none():
    async def go():
        async with _client_for(b"not found") as client:
            client._transport = httpx.MockTransport(lambda r: httpx.Response(404))
            return await fetch_static(client, "https://x.test/")

    assert asyncio.run(go()) is None


def test_max_page_bytes_is_1_5mb():
    assert MAX_PAGE_BYTES == 1_500_000


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all fetch_static tests passed")
