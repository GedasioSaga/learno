"""Routes a decoded request to the handler registered for its method.

Registration is separate from the transport loop so later fases add handlers
(``apkg.import``, ``fsrs.schedule``, ``pdf.extract``) in `handlers/` without
touching `transport.py`.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from typing import Any

from learno_sidecar.protocol import ErrorCode, ProtocolError, Request, Response

Handler = Callable[[Mapping[str, Any]], Mapping[str, Any]]

# `logging`'s default handler writes to stderr, never stdout — the wire format
# in `transport.py` owns stdout exclusively (one JSON response per line), so a
# handler-crash log here can't corrupt a response the Rust side is parsing.
_logger = logging.getLogger(__name__)


class Dispatcher:
    def __init__(self) -> None:
        self._handlers: dict[str, Handler] = {}

    def register(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler

    def methods(self) -> list[str]:
        """Every method currently answerable — what `health.check` reports as capabilities."""
        return sorted(self._handlers)

    def dispatch(self, request: Request) -> Response:
        handler = self._handlers.get(request.method)
        if handler is None:
            return Response.failure(
                request.id,
                ErrorCode.METHOD_NOT_FOUND,
                f"unknown method: {request.method}",
            )

        try:
            result = handler(request.params)
        except ProtocolError as exc:
            return Response.failure(request.id, exc.code, str(exc))
        except Exception as exc:
            # Dispatch boundary: a handler bug must fail this one request, not
            # take down the process the Rust side is waiting on for every
            # other in-flight call — so this stays deliberately broad instead
            # of listing every exception type a future handler might raise.
            # `.exception()` records the traceback (to stderr, see `_logger`
            # above) instead of just swallowing it, so a real bug is still
            # visible somewhere.
            _logger.exception("handler for %r raised", request.method)
            return Response.failure(request.id, ErrorCode.INTERNAL_ERROR, str(exc))

        return Response.success(request.id, result)
