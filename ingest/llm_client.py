"""The one place an LLM client is constructed.

Every LLM call in this product goes through OpenRouter: one key, one bill, one
place to swap a model. OpenRouter exposes an ANTHROPIC-COMPATIBLE API, so the
`anthropic` SDK — including `messages.parse()` and its pydantic
`output_format` — works unchanged; only the base URL and the key differ.
"""

import os

from anthropic import Anthropic

# NOTE the missing "/v1": the Anthropic SDK appends "/v1/messages" itself.
# Setting this to ".../api/v1" produces ".../api/v1/v1/messages", which
# OpenRouter answers with an HTML page — so the failure looks like a JSON
# parse error a long way from its cause.
OPENROUTER_BASE_URL = "https://openrouter.ai/api"


def get_llm_client() -> Anthropic:
    """An Anthropic-SDK client pointed at OpenRouter."""
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is not set")
    return Anthropic(api_key=api_key, base_url=OPENROUTER_BASE_URL)


def routed_model(model: str) -> str:
    """Namespace a bare model slug for OpenRouter.

    usage.py's PRICING and MODEL_FOR_CALL are keyed on the BARE slug, and so is
    everything recorded in `ingest_jobs.llm_cost_by_type`. The prefix is added
    here, at the API boundary, and nowhere else — so cost history stays
    comparable across the switch instead of splitting into two sets of keys.
    """
    return model if "/" in model else f"anthropic/{model}"
