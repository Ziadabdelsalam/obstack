"""obstack demo agent — the reference producer for the ingest pipeline (D15).

`POST /chat` runs one scripted agent turn and emits the span tree the product is
built around:

    POST /chat                     api    (auto-instrumented FastAPI server span)
    └─ agent.answer_question       agent  (obstack.agent.step)
       ├─ tool.knowledge_lookup    tool   (obstack.tool.name)
       │  └─ POST /internal/tools/knowledge   api  (the self-call's server span,
       │                                            reached through injected
       │                                            traceparent headers)
       └─ chat <model>             llm    (D8 gen_ai.* attributes)

Nothing here imports an obstack SDK: the app is plain OpenTelemetry, which is
what makes it evidence that any OTel-instrumented service can point at obstack.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.propagate import inject
from pydantic import BaseModel

import llm
import telemetry

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
# httpx narrates every request at INFO, which would double every log line the
# demo emits on purpose.
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("demo-agent")
tracer = trace.get_tracer("obstack.demo.agent")

# Where the tool span's HTTP self-call goes. Inside the container the app is its
# own upstream; the call is real so that context propagation is exercised on the
# wire rather than assumed.
SELF_URL = os.getenv("DEMO_SELF_URL", "http://127.0.0.1:8000")

# Seconds between self-generated requests. Unset or 0 means the app only reacts
# to traffic you send it.
LOOP_INTERVAL_S = float(os.getenv("LOOP_INTERVAL_S") or 0)

DEFAULT_QUESTION = "Why did checkout p99 latency jump this afternoon?"

LOOP_QUESTIONS = [
    DEFAULT_QUESTION,
    "Which service is burning the most tokens today?",
    "Did the last deploy change the error rate on the payments API?",
]

# The tool's "knowledge base". Small and fixed: the demo is about the shape of
# the telemetry, not about retrieval.
KNOWLEDGE = {
    "latency": "the p99 on checkout tracks the vector-store lookup inside the agent step",
    "token": "the summarizer agent re-sends the full conversation on every turn",
    "error": "the payments API started returning 502s nine minutes after the last deploy",
}
FALLBACK_FACT = "no runbook entry matches this question yet"


class ChatRequest(BaseModel):
    message: str = DEFAULT_QUESTION


class ChatResponse(BaseModel):
    trace_id: str
    answer: str
    model: str
    input_tokens: int
    output_tokens: int


class ToolRequest(BaseModel):
    question: str


class ToolResponse(BaseModel):
    facts: list[str]


@asynccontextmanager
async def lifespan(app: FastAPI):
    loop = asyncio.create_task(self_traffic()) if LOOP_INTERVAL_S > 0 else None
    yield
    if loop is not None:
        loop.cancel()
    # Flush both batch processors: without this the telemetry of the last
    # request dies with the process, which is exactly the request a demo run
    # cares about.
    shutdown_telemetry()


app = FastAPI(title="obstack demo agent", lifespan=lifespan)
shutdown_telemetry = telemetry.configure(app)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/chat")
async def chat(request: ChatRequest) -> ChatResponse:
    log.info("chat request received: %s", request.message)

    with tracer.start_as_current_span(
        "agent.answer_question",
        attributes={"obstack.agent.step": "answer_question"},
    ):
        facts = await lookup_knowledge(request.message)
        completion = await llm.complete(request.message, facts)
        log.info(
            "agent answered with %s (%d output tokens)",
            completion.model,
            completion.output_tokens,
        )

    trace_id = trace.get_current_span().get_span_context().trace_id
    return ChatResponse(
        trace_id=format(trace_id, "032x"),
        answer=completion.text,
        model=completion.model,
        input_tokens=completion.input_tokens,
        output_tokens=completion.output_tokens,
    )


async def lookup_knowledge(question: str) -> list[str]:
    """The tool leg: a real HTTP round trip back into this same app."""
    with tracer.start_as_current_span(
        "tool.knowledge_lookup",
        attributes={"obstack.tool.name": "knowledge_lookup"},
    ):
        headers: dict[str, str] = {}
        inject(headers)  # traceparent, so the callee's span joins this trace
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                f"{SELF_URL}/internal/tools/knowledge",
                json={"question": question},
                headers=headers,
            )
        response.raise_for_status()
        facts = ToolResponse(**response.json()).facts
        log.info("knowledge lookup returned %d fact(s)", len(facts))
        return facts


@app.post("/internal/tools/knowledge")
async def knowledge(request: ToolRequest) -> ToolResponse:
    """The tool's upstream. Auto-instrumented like any other route."""
    question = request.question.lower()
    facts = [fact for keyword, fact in KNOWLEDGE.items() if keyword in question]
    return ToolResponse(facts=facts or [FALLBACK_FACT])


async def self_traffic() -> None:
    """Optional background traffic, so a stack left running keeps filling up."""
    log.info("self-traffic enabled, one request every %ss", LOOP_INTERVAL_S)
    turn = 0
    async with httpx.AsyncClient(timeout=30) as client:
        while True:
            await asyncio.sleep(LOOP_INTERVAL_S)
            question = LOOP_QUESTIONS[turn % len(LOOP_QUESTIONS)]
            turn += 1
            try:
                await client.post(f"{SELF_URL}/chat", json={"message": question})
            except httpx.HTTPError as exc:
                log.warning("self-traffic request failed: %s", exc)
