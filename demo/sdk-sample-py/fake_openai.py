"""A deterministic OpenAI-compatible endpoint, served by this app's own process.

The sample needs no API key and reaches no network, but the point of the sample
is that the REAL `openai` client is the thing obstack instruments — a stubbed
client would prove that a wrapper works on a value the test wrote itself, which
is the one thing nobody doubts. So the client is real and its `base_url` points
here: an ordinary HTTP server on loopback answering `/v1/chat/completions` with
a well-formed chat completion.

It runs on its own thread rather than as a route on the FastAPI app because a
model provider is not part of the application's trace. A route here would be
instrumented like any other, and every request would emit a second, meaningless
trace holding nothing but the provider's own server span.

Deterministic on purpose — same request, same answer, same token counts — so the
evidence a run produces is an equality, not a shape.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# The openai client refuses to construct without one. It is not a credential:
# nothing this app sends leaves its own loopback interface.
API_KEY = "obstack-sample-no-credential"

# A model ingest's pricing table knows, so the LLM span lands with cost_usd
# non-zero rather than silently free.
MODEL = "gpt-4o-mini"

PATH = "/v1/chat/completions"


def start() -> str:
    """Serve the endpoint on a free loopback port; return the client base URL.

    The thread is a daemon: the endpoint lives exactly as long as the app does
    and has no shutdown of its own to get wrong.
    """
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}/v1"


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's naming
        if self.path != PATH:
            self._send(404, {"error": {"message": f"no such route: {self.path}"}})
            return
        length = int(self.headers.get("Content-Length") or 0)
        request = json.loads(self.rfile.read(length) or b"{}")
        self._send(200, _completion(request.get("messages") or []))

    def _send(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args: Any) -> None:
        """Silence the per-request line stdlib prints to stderr."""


def _completion(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """The response body, in the shape the openai client parses."""
    prompt = "\n".join(str(message.get("content", "")) for message in messages)
    answer = _answer(prompt)
    return {
        "id": "chatcmpl-obstack-sample",
        "object": "chat.completion",
        "created": 1700000000,
        "model": MODEL,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": answer},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": _tokens(prompt),
            "completion_tokens": _tokens(answer),
            "total_tokens": _tokens(prompt) + _tokens(answer),
        },
    }


def _answer(prompt: str) -> str:
    """An answer built from the prompt, so the completion column reads like one.

    The retrieved facts arrive as `- ` bullets; leading with the first of them
    makes the answer specific to the question that was asked.
    """
    facts = [line[2:] for line in prompt.splitlines() if line.startswith("- ")]
    lead = facts[0] if facts else "there is no runbook entry for that yet"
    return f"Based on the retrieved facts, {lead}. Start there."


def _tokens(text: str) -> int:
    """Roughly four characters per token — the usual English approximation."""
    return max(1, round(len(text) / 4))
