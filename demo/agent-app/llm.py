"""The LLM leg of the demo trace.

One span per completion, carrying the full D8 GenAI attribute set. The model
call itself is a deterministic built-in fake unless `OPENAI_API_KEY` is set, so
the demo produces identical, priced telemetry on a laptop with no credentials
and no network.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import httpx
from opentelemetry import trace
from opentelemetry.trace import SpanKind

tracer = trace.get_tracer("obstack.demo.agent")

# A model the embedded pricing table knows, so `cost_usd` is non-zero on the
# fake path too.
DEFAULT_MODEL = "gpt-4o-mini"

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
SYSTEM_PROMPT = (
    "You are the obstack demo agent. Answer the operator's question in two "
    "sentences, using the retrieved facts."
)


@dataclass(frozen=True)
class Completion:
    model: str
    text: str
    input_tokens: int
    output_tokens: int
    finish_reason: str


async def complete(question: str, facts: list[str]) -> Completion:
    """Answer `question` from `facts`, emitting the LLM span."""
    model = os.getenv("OPENAI_MODEL", DEFAULT_MODEL)
    prompt = _prompt(question, facts)

    # CLIENT, per the GenAI semantic conventions: the span covers a call out to
    # a model provider, not work done in this process.
    with tracer.start_as_current_span(f"chat {model}", kind=SpanKind.CLIENT) as span:
        span.set_attribute("gen_ai.system", "openai")
        span.set_attribute("gen_ai.operation.name", "chat")
        span.set_attribute("gen_ai.request.model", model)
        span.set_attribute("gen_ai.prompt", prompt)

        api_key = os.getenv("OPENAI_API_KEY")
        if api_key:
            completion = await _call_openai(api_key, model, prompt)
        else:
            completion = _fake(model, question, facts, prompt)

        span.set_attribute("gen_ai.response.model", completion.model)
        span.set_attribute("gen_ai.completion", completion.text)
        span.set_attribute("gen_ai.usage.input_tokens", completion.input_tokens)
        span.set_attribute("gen_ai.usage.output_tokens", completion.output_tokens)
        span.set_attribute("gen_ai.response.finish_reasons", [completion.finish_reason])
        return completion


def _prompt(question: str, facts: list[str]) -> str:
    retrieved = "\n".join(f"- {fact}" for fact in facts)
    return f"{SYSTEM_PROMPT}\n\nRetrieved facts:\n{retrieved}\n\nQuestion: {question}"


def _fake(model: str, question: str, facts: list[str], prompt: str) -> Completion:
    """A completion that reads like the real thing and never varies."""
    lead = facts[0] if facts else "there is no matching runbook entry"
    text = (
        f"Based on the trace data, {lead}. "
        f"Start there before changing anything else about {_subject(question)}."
    )
    return Completion(
        model=model,
        text=text,
        input_tokens=_tokens(prompt),
        output_tokens=_tokens(text),
        finish_reason="stop",
    )


def _subject(question: str) -> str:
    """The tail of the question, used to make the fake answer sound specific."""
    words = question.rstrip("?").split()
    return " ".join(words[-4:]) if words else "the service"


def _tokens(text: str) -> int:
    """Roughly four characters per token — the usual English approximation."""
    return max(1, round(len(text) / 4))


async def _call_openai(api_key: str, model: str, prompt: str) -> Completion:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            OPENAI_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
    response.raise_for_status()
    body = response.json()
    choice = body["choices"][0]
    usage = body.get("usage", {})
    return Completion(
        model=body.get("model", model),
        text=choice["message"]["content"],
        input_tokens=usage.get("prompt_tokens", 0),
        output_tokens=usage.get("completion_tokens", 0),
        finish_reason=choice.get("finish_reason", "stop"),
    )
