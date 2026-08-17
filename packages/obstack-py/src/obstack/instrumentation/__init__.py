"""obstack's own provider instrumentations, turned on by `obstack.init()`.

Exported so an application that wires its own OpenTelemetry can still use them —
`OpenAIInstrumentor().instrument(tracer_provider=...)` against a provider obstack
never touched — but the supported path is `init()`, which installs both.
"""

from .anthropic import AnthropicInstrumentor
from .openai import OpenAIInstrumentor

__all__ = ["AnthropicInstrumentor", "OpenAIInstrumentor"]
