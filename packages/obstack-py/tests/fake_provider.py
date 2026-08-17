"""A local OpenAI- and Anthropic-compatible endpoint the real clients talk to.

The instrumentation is only worth anything if it observes the actual client
library, so no test here constructs a response object or calls a wrapper
directly: every span in this suite comes from `openai` or `anthropic` doing a
real HTTP round trip, with `base_url` pointed here instead of at the provider.
A stubbed client would prove that the wrapper works on a value the test wrote
itself, which is the one thing nobody doubts.

Deterministic on purpose — fixed text, fixed token counts, fixed finish reason —
so an attribute assertion can be an equality rather than a shape check. No
credentials are involved: the clients require a non-empty API key string and get
a placeholder that never leaves this machine.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterator

# The clients refuse to construct without one. It is not a credential.
API_KEY = "obstack-test-no-credential"

OPENAI_MODEL = "gpt-4o-mini"
OPENAI_ANSWER = "The p99 tracks the vector-store lookup inside the agent step."
OPENAI_INPUT_TOKENS = 11
OPENAI_OUTPUT_TOKENS = 7
OPENAI_FINISH_REASON = "stop"

ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929"
ANTHROPIC_ANSWER = "The payments API started returning 502s after the last deploy."
ANTHROPIC_INPUT_TOKENS = 9
ANTHROPIC_OUTPUT_TOKENS = 5
ANTHROPIC_STOP_REASON = "end_turn"

# Ask for this model and the endpoint answers 500, so the client raises the way
# a real outage makes it raise.
FAILING_MODEL = "boom"


def _openai_body() -> dict[str, Any]:
    return {
        "id": "chatcmpl-obstack-fake",
        "object": "chat.completion",
        "created": 1700000000,
        "model": OPENAI_MODEL,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": OPENAI_ANSWER},
                "finish_reason": OPENAI_FINISH_REASON,
            }
        ],
        "usage": {
            "prompt_tokens": OPENAI_INPUT_TOKENS,
            "completion_tokens": OPENAI_OUTPUT_TOKENS,
            "total_tokens": OPENAI_INPUT_TOKENS + OPENAI_OUTPUT_TOKENS,
        },
    }


def _openai_stream() -> bytes:
    """The same answer as server-sent events, for the streaming pass-through."""
    chunks = [
        {
            "id": "chatcmpl-obstack-fake",
            "object": "chat.completion.chunk",
            "created": 1700000000,
            "model": OPENAI_MODEL,
            "choices": [
                {
                    "index": 0,
                    "delta": {"role": "assistant", "content": OPENAI_ANSWER},
                    "finish_reason": None,
                }
            ],
        },
        {
            "id": "chatcmpl-obstack-fake",
            "object": "chat.completion.chunk",
            "created": 1700000000,
            "model": OPENAI_MODEL,
            "choices": [
                {"index": 0, "delta": {}, "finish_reason": OPENAI_FINISH_REASON}
            ],
        },
    ]
    lines = [f"data: {json.dumps(chunk)}\n\n" for chunk in chunks]
    lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


def _anthropic_body() -> dict[str, Any]:
    return {
        "id": "msg_obstack_fake",
        "type": "message",
        "role": "assistant",
        "model": ANTHROPIC_MODEL,
        "content": [{"type": "text", "text": ANTHROPIC_ANSWER}],
        "stop_reason": ANTHROPIC_STOP_REASON,
        "stop_sequence": None,
        "usage": {
            "input_tokens": ANTHROPIC_INPUT_TOKENS,
            "output_tokens": ANTHROPIC_OUTPUT_TOKENS,
        },
    }


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's naming
        length = int(self.headers.get("Content-Length") or 0)
        request = json.loads(self.rfile.read(length) or b"{}")

        if request.get("model") == FAILING_MODEL:
            self._send(500, b'{"error":{"message":"the model is on fire"}}')
        elif self.path == "/v1/chat/completions" and request.get("stream"):
            self._send(200, _openai_stream(), content_type="text/event-stream")
        elif self.path == "/v1/chat/completions":
            self._send(200, json.dumps(_openai_body()).encode())
        elif self.path == "/v1/messages":
            self._send(200, json.dumps(_anthropic_body()).encode())
        else:
            self._send(404, b'{"error":{"message":"no such route"}}')

    def _send(
        self, status: int, body: bytes, content_type: str = "application/json"
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: Any) -> None:
        """Silence the per-request line stdlib prints to stderr."""


def serve() -> Iterator[str]:
    """Run the endpoint on a free port and yield its base URL."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
