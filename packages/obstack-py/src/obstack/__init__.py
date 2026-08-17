"""obstack — agent observability in two lines.

    import obstack
    obstack.init()

That call configures OpenTelemetry from the standard `OTEL_*` environment and
turns on the instrumentation that produces the four layers an obstack trace is
made of: api from the HTTP framework, llm from the provider client, and agent
and tool from the two decorators below.

    @obstack.trace_agent
    async def answer_question(question: str) -> str:
        facts = await look_up(question)
        return (await client.chat.completions.create(...)).choices[0].message.content

    @obstack.trace_tool
    async def look_up(question: str) -> list[str]:
        ...

Nothing here can raise into an application: a broken endpoint, an unparseable
`OTEL_*` value or a failing exporter costs telemetry and nothing else.
"""

from ._decorators import trace_agent, trace_tool
from ._sdk import Obstack, init

__version__ = "0.1.0"

__all__ = ["Obstack", "init", "trace_agent", "trace_tool"]
