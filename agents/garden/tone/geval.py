"""Tone check for the garden agents' outbound messages: DeepEval G-Eval, advice only.

    python agents/garden/tone/geval.py <messages.json from pick.mjs> <tone.json>

One judge call per message (the evaluation steps are fixed below, so DeepEval does not spend a
call writing them), at most five messages a day, on the cheapest adequate model through
OpenRouter with the garden's own key (GARDEN_API_KEY, $1 a day shared with the garden).
Never fails the run: any problem is written into tone.json as "skipped" for the report to show.
"""

import json
import os
import re
import sys

os.environ.setdefault("DEEPEVAL_DISABLE_DOTENV", "1")
os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "YES")

MODEL = "anthropic/claude-haiku-5.5"
CRITERIA = (
    "Facundo's agents write to florist shops by email. The tone we want with florists is "
    "friendly and short: warm without being gushing, plain words, no corporate filler, no pressure, "
    "and it says clearly what the florist should do next, if anything."
)
STEPS = [
    f"Context for every step: {CRITERIA}",
    "Check whether the message is short: a florist can read it in under 20 seconds, with no repeated points.",
    "Check whether it is friendly and human, neither cold nor over-apologetic or salesy.",
    "Check whether it says clearly what happens next or what the florist needs to do, when anything is needed.",
    "Penalise jargon, internal terms, or anything a busy florist would not understand.",
]


def write(path, payload):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def main(src, out):
    with open(src, encoding="utf-8") as f:
        messages = json.load(f)
    if not messages:
        write(out, {"results": []})
        return
    if not os.environ.get("GARDEN_API_KEY"):
        write(out, {"skipped": "the garden AI key is not set here"})
        return
    try:
        from deepeval.metrics import GEval
        from deepeval.models import DeepEvalBaseLLM
        from deepeval.test_case import LLMTestCase
        try:
            from deepeval.test_case import SingleTurnParams as Params
        except ImportError:
            from deepeval.test_case import LLMTestCaseParams as Params
        from openai import OpenAI
    except ImportError as e:
        write(out, {"skipped": f"DeepEval is not installed ({e.name})"})
        return

    class OpenRouterJudge(DeepEvalBaseLLM):
        def __init__(self):
            self.client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=os.environ["GARDEN_API_KEY"])
            super().__init__(MODEL)

        def load_model(self):
            return self.client

        def generate(self, prompt, schema=None):
            reply = self.client.chat.completions.create(
                model=MODEL, messages=[{"role": "user", "content": prompt}], max_tokens=600,
                # Haiku 5.5 otherwise spends the whole budget on hidden reasoning and returns
                # empty content (measured 2026-10-13: 80 of 80 tokens were reasoning).
                extra_body={"reasoning": {"enabled": False}},
            ).choices[0].message.content or ""
            if schema is None:
                return reply
            match = re.search(r"\{.*\}", reply, re.S)
            return schema.model_validate_json(match.group(0) if match else reply)

        async def a_generate(self, prompt, schema=None):
            return self.generate(prompt, schema)

        def get_model_name(self):
            return MODEL

    judge = OpenRouterJudge()
    results = []
    for m in messages:
        metric = GEval(
            name="Tone with florists",
            criteria=CRITERIA,
            evaluation_steps=STEPS,
            evaluation_params=[Params.ACTUAL_OUTPUT],
            model=judge,
            async_mode=False,
        )
        excerpt = " ".join(m["text"].split())[:160]
        try:
            metric.measure(LLMTestCase(input=f"Message to {m['to']}", actual_output=m["text"]))
            results.append({"id": m["id"], "to": m["to"], "excerpt": excerpt, "score": metric.score, "reason": metric.reason})
        except Exception as e:  # advice only: one bad call must not lose the others
            results.append({"id": m["id"], "to": m["to"], "excerpt": excerpt, "score": None, "reason": f"not scored ({type(e).__name__})"})
    write(out, {"model": MODEL, "results": results})


if __name__ == "__main__":
    try:
        main(sys.argv[1], sys.argv[2])
    except Exception as e:
        write(sys.argv[2], {"skipped": f"the tone check broke ({type(e).__name__}: {e})"})
