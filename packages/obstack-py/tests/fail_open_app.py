"""The smallest possible obstack application, run as a subprocess by the tests.

Fail-open is a claim about a whole assembled process — init() building real
exporters against a real environment — so it cannot honestly be tested in a
process where the test harness has already installed a working pipeline. This
file is that process: two lines of setup, two decorated functions, one number
printed. Whatever the environment does to it, it is expected to exit 0 and print
the same answer.

The trace id it prints is how a caller tells the two failure modes apart. A
non-zero id means the SDK really did start a recording span and really did try
to ship it; all zeroes mean init() failed open and left the application running
on the API's no-op tracer.
"""

from __future__ import annotations

from opentelemetry import trace

import obstack


@obstack.trace_tool
def add(a: int, b: int) -> int:
    return a + b


@obstack.trace_agent("answer")
def answer() -> tuple[int, int]:
    total = add(2, 40)
    return total, trace.get_current_span().get_span_context().trace_id


def main() -> None:
    handle = obstack.init()
    total, trace_id = answer()
    handle.shutdown()
    print(f"answer={total} trace_id={trace_id:032x}")


main()
