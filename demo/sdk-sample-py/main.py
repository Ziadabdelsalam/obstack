"""obstack SDK sample — the four-layer trace from the documented two lines.

`POST /chat` runs one agent turn and emits:

    POST /chat                  api    FastAPI instrumentation, turned on by init()
    └─ agent.answer_question    agent  @obstack.trace_agent
       ├─ tool.knowledge_lookup tool   @obstack.trace_tool
       └─ chat gpt-4o-mini      llm    the openai client, patched by init()

plus three spans the ASGI server emits about its own plumbing, which ingest
classifies `other` — seven rows per request in total, listed in README.md.

The telemetry code in this application is `import obstack`, `obstack.init()` and
the two decorators. No module here imports OpenTelemetry at all (README.md gives
the grep), and that absence is what the sample is evidence of: an application
gets the whole trace from the install and the two lines, not from wiring it
writes itself.

`demo/agent-app/` proves the other half of the same claim with plain OTel and no
SDK (D15). This app is deliberately its own thing rather than a conversion of
it; the trace they produce is the same shape.
"""

from __future__ import annotations

import logging

import obstack

# Ordinary application logging, and it has to be configured before init():
# init() puts its own handler on the root logger, and basicConfig() does nothing
# once the root logger has a handler — the level below would never be applied
# and these info lines would never be emitted at all.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
# The HTTP client underneath openai narrates every request at INFO, which would
# double every log line this app emits on purpose. openai 3.x is on httpx2, so
# that — not `httpx` — is the logger to quiet.
logging.getLogger("httpx2").setLevel(logging.WARNING)
log = logging.getLogger("sdk-sample-py")

# The two lines, and they run before FastAPI is imported: init() instruments
# FastAPI by replacing the class on the `fastapi` module, so a `from fastapi
# import FastAPI` that ran first would keep the original class, every app built
# from it would be uninstrumented, and the api layer would be missing from every
# trace with nothing anywhere saying so. Measured, not assumed — see README.md.
obstack.init()

from fastapi import FastAPI  # noqa: E402 — after init(), deliberately
from openai import AsyncOpenAI  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import fake_openai  # noqa: E402

app = FastAPI(title="obstack SDK sample (python)")

# The real openai client, pointed at the deterministic endpoint this process
# serves on loopback. init() patched `chat.completions.create` before this line
# ran; apart from `base_url` this is exactly the client an application has.
client = AsyncOpenAI(base_url=fake_openai.start(), api_key=fake_openai.API_KEY)

SYSTEM_PROMPT = (
    "You are the obstack sample agent. Answer the operator's question in two "
    "sentences, using the retrieved facts."
)

# The tool's "knowledge base". Small and fixed: the sample is about the shape of
# the telemetry, not about retrieval.
KNOWLEDGE = {
    "latency": "the p99 on checkout tracks the vector-store lookup inside the agent step",
    "token": "the summarizer agent re-sends the full conversation on every turn",
    "error": "the payments API started returning 502s nine minutes after the last deploy",
}
FALLBACK_FACT = "no runbook entry matches this question yet"

DEFAULT_QUESTION = "Why did checkout p99 latency jump this afternoon?"


class ChatRequest(BaseModel):
    message: str = DEFAULT_QUESTION


class ChatResponse(BaseModel):
    answer: str
    model: str
    input_tokens: int
    output_tokens: int


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/chat")
async def chat(request: ChatRequest) -> ChatResponse:
    log.info("chat request received: %s", request.message)
    return await answer_question(request.message)


@obstack.trace_agent
async def answer_question(message: str) -> ChatResponse:
    """The agent layer: one span named `agent.answer_question`."""
    facts = knowledge_lookup(message)
    completion = await client.chat.completions.create(
        model=fake_openai.MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": _question(message, facts)},
        ],
    )
    usage = completion.usage
    log.info(
        "agent answered with %s (%d output tokens)",
        completion.model,
        usage.completion_tokens,
    )
    return ChatResponse(
        answer=completion.choices[0].message.content,
        model=completion.model,
        input_tokens=usage.prompt_tokens,
        output_tokens=usage.completion_tokens,
    )


@obstack.trace_tool
def knowledge_lookup(question: str) -> list[str]:
    """The tool layer: one span named `tool.knowledge_lookup`.

    Synchronous, where the agent step is `async def` — both decorators cover
    both, and a sample that only ever showed one of them would be claiming half
    of what was built.
    """
    asked = question.lower()
    facts = [fact for keyword, fact in KNOWLEDGE.items() if keyword in asked]
    log.info("knowledge lookup returned %d fact(s)", len(facts) or 1)
    return facts or [FALLBACK_FACT]


def _question(message: str, facts: list[str]) -> str:
    retrieved = "\n".join(f"- {fact}" for fact in facts)
    return f"Retrieved facts:\n{retrieved}\n\nQuestion: {message}"
