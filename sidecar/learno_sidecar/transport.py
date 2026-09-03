"""Blocking stdio loop: one JSON request per line in, one response per line out.

Kept separate from `Dispatcher` so tests can drive dispatch through in-memory
text streams instead of real stdin/stdout, and so a future transport (e.g. a
socket, if the sidecar ever needs one) could reuse the same `Dispatcher`
unchanged.
"""

from __future__ import annotations

from typing import TextIO

from learno_sidecar.dispatcher import Dispatcher
from learno_sidecar.protocol import ProtocolError, Request, Response


def handle_line(dispatcher: Dispatcher, line: str) -> str:
    """Decodes and dispatches one request line, returning the response line."""
    try:
        request = Request.parse(line)
    except ProtocolError as exc:
        return Response.failure(exc.request_id, exc.code, str(exc)).to_line()

    return dispatcher.dispatch(request).to_line()


def serve(dispatcher: Dispatcher, reader: TextIO, writer: TextIO) -> None:
    """Reads requests until `reader` closes — the Rust side closing the pipe
    on app shutdown is the normal way this loop ends."""
    for raw_line in reader:
        line = raw_line.strip()
        if not line:
            continue
        writer.write(handle_line(dispatcher, line) + "\n")
        writer.flush()
