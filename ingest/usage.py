"""Per-run Anthropic cost tracking for the ingest pipeline.

Cost is exact arithmetic: tokens x the call's model rate. The Anthropic API
returns token counts, not dollars, so we price them here. Tracked per call
type (ecommerce/email/phone/owner/draft) and per model so a per-type model
swap (workstream B) is measurable. Single-threaded asyncio use: `record` runs
after each `await` on the event loop, so plain `+=` is safe (no lock).
"""

import sys
from dataclasses import dataclass, field

# (input_per_mtok, output_per_mtok) in USD per 1,000,000 tokens.
# Sonnet-5: intro rate through 2026-08-31 (standard is 3.00 / 15.00).
# Haiku 4.5: 1.00 / 5.00. A call against a model absent here contributes $0.
PRICING: dict[str, tuple[float, float]] = {
    "claude-sonnet-5": (2.00, 10.00),
    "claude-haiku-4-5": (1.00, 5.00),
}

CALL_TYPES: tuple[str, ...] = ("ecommerce", "email", "phone", "owner", "draft", "relevance")

# Per-call-type model routing. phone + email are mechanical candidate
# *selection* → Haiku (~half the token cost). owner-name is extraction, not
# writing, and a spot-check on the judgment edge cases (real owner vs
# brand-only / staff mention / testimonial, across es/en/de) showed 6/6
# owner_name agreement with Sonnet — including no over-extraction on the null
# cases — so it runs on Haiku too. relevance (is-this-actually-a-florist
# judgment, for Maps results whose category didn't clearly match) and
# ecommerce (is-this-a-store judgment) stay on Sonnet-5 — both are business-type
# judgment calls, not mechanical extraction, and relevance drops are permanent
# (see relevance.py), so accuracy is favored over the small cost delta. draft
# is unused here (moved on-demand to the dashboard). Flip any entry to
# re-route; cost tracking (llm_cost_by_type) measures it.
MODEL_FOR_CALL: dict[str, str] = {ct: "claude-sonnet-5" for ct in CALL_TYPES}
MODEL_FOR_CALL["phone"] = "claude-haiku-4-5"
MODEL_FOR_CALL["email"] = "claude-haiku-4-5"
MODEL_FOR_CALL["owner"] = "claude-haiku-4-5"


@dataclass
class _Bucket:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    model: str = ""


@dataclass
class UsageTracker:
    _buckets: dict[str, _Bucket] = field(default_factory=dict)

    def record(self, call_type: str, model: str, response) -> None:
        """Add one real API call's usage to `call_type`'s bucket. Tolerant of a
        missing/None usage payload (counts the call, adds 0 tokens)."""
        bucket = self._buckets.setdefault(call_type, _Bucket())
        bucket.calls += 1
        bucket.model = model
        usage = getattr(response, "usage", None)
        i = getattr(usage, "input_tokens", None) or 0
        o = getattr(usage, "output_tokens", None) or 0
        bucket.input_tokens += i
        bucket.output_tokens += o

    def _bucket_cost(self, b: _Bucket) -> float:
        rate = PRICING.get(b.model)
        if rate is None:
            print(f"[usage] no pricing for model {b.model!r}; counting $0.", file=sys.stderr)
            return 0.0
        in_rate, out_rate = rate
        return b.input_tokens / 1e6 * in_rate + b.output_tokens / 1e6 * out_rate

    @property
    def cost_usd(self) -> float:
        return sum(self._bucket_cost(b) for b in self._buckets.values())

    @property
    def total_input_tokens(self) -> int:
        return sum(b.input_tokens for b in self._buckets.values())

    @property
    def total_output_tokens(self) -> int:
        return sum(b.output_tokens for b in self._buckets.values())

    @property
    def total_calls(self) -> int:
        return sum(b.calls for b in self._buckets.values())

    def to_by_type_dict(self) -> dict:
        """JSONB payload for ingest_jobs.llm_cost_by_type. Omits types that never ran."""
        return {
            ct: {
                "calls": b.calls,
                "input_tokens": b.input_tokens,
                "output_tokens": b.output_tokens,
                "cost_usd": round(self._bucket_cost(b), 6),
                "model": b.model,
            }
            for ct, b in self._buckets.items()
        }
