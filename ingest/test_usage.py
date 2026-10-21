"""Sanity assertions for the cost UsageTracker. Run: uv run python test_usage.py"""
from usage import CALL_TYPES, MODEL_FOR_CALL, PRICING, UsageTracker


class _Usage:
    def __init__(self, i, o):
        self.input_tokens = i
        self.output_tokens = o


class _Resp:
    def __init__(self, i, o):
        self.usage = _Usage(i, o)


def test_mixed_model_cost():
    t = UsageTracker()
    # 1,000,000 input + 1,000,000 output on Sonnet-5 => $2 + $10 = $12
    t.record("ecommerce", "claude-sonnet-5", _Resp(1_000_000, 1_000_000))
    # 1,000,000 input + 1,000,000 output on Haiku 4.5 => $1 + $5 = $6
    t.record("email", "claude-haiku-4-5", _Resp(1_000_000, 1_000_000))
    assert abs(t.cost_usd - 18.0) < 1e-9, t.cost_usd
    assert t.total_calls == 2
    assert t.total_input_tokens == 2_000_000


def test_buckets_and_dict():
    t = UsageTracker()
    t.record("email", "claude-sonnet-5", _Resp(100, 10))
    t.record("email", "claude-sonnet-5", _Resp(100, 10))
    d = t.to_by_type_dict()
    assert d["email"]["calls"] == 2
    assert d["email"]["input_tokens"] == 200
    assert d["email"]["model"] == "claude-sonnet-5"
    assert "ecommerce" not in d  # types that never ran are omitted


def test_none_usage_and_unknown_model_no_op():
    t = UsageTracker()
    t.record("owner", "claude-sonnet-5", _Resp(None, None))  # tolerated
    t.record("phone", "made-up-model", _Resp(100, 10))       # unknown model -> $0, no crash
    assert t.cost_usd == 0.0
    assert t.total_calls == 2  # calls still counted


def test_relevance_call_type_routed_to_sonnet():
    assert "relevance" in CALL_TYPES
    assert MODEL_FOR_CALL["relevance"] == "claude-sonnet-5"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all usage tests passed")
