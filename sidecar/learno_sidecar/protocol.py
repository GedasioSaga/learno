"""Wire format for the stdio protocol shared with the Rust bridge.

One JSON object per line, in both directions. Every request carries a
correlation id the Rust caller invented; the matching response echoes it
back, so a caller that pipelines several requests can match responses that
arrive out of order. Keep the field names here in lockstep with
``src-tauri/src/sidecar/protocol.rs`` — the two sides agree on shape by
convention, not by a shared schema file.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class ErrorCode(StrEnum):
    """Stable, machine-readable failure categories the Rust side can branch on."""

    INVALID_REQUEST = "invalid_request"
    METHOD_NOT_FOUND = "method_not_found"
    INTERNAL_ERROR = "internal_error"


class ProtocolError(Exception):
    """Raised to fail one request with a stable code instead of the transport.

    A handler in a later fase (e.g. an invalid ``.apkg``) raises this with its
    own ``ErrorCode``-like string to report a client-caused failure without
    crashing the process.
    """

    def __init__(self, code: str, message: str, request_id: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.request_id = request_id


@dataclass(frozen=True)
class Request:
    id: str
    method: str
    params: Mapping[str, Any] = field(default_factory=dict)

    @staticmethod
    def parse(line: str) -> Request:
        """Decodes one request line, raising `ProtocolError` for anything malformed.

        Best-effort recovers the request id even from an otherwise-invalid
        payload, so the error response can still be correlated by the caller.
        """
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ProtocolError(ErrorCode.INVALID_REQUEST, f"malformed JSON: {exc}") from exc

        if not isinstance(payload, dict):
            raise ProtocolError(ErrorCode.INVALID_REQUEST, "request must be a JSON object")

        raw_id = payload.get("id")
        request_id_hint = raw_id if isinstance(raw_id, str) else None

        if not isinstance(raw_id, str) or not raw_id:
            raise ProtocolError(
                ErrorCode.INVALID_REQUEST,
                '"id" must be a non-empty string',
                request_id=request_id_hint,
            )

        method = payload.get("method")
        if not isinstance(method, str) or not method:
            raise ProtocolError(
                ErrorCode.INVALID_REQUEST,
                '"method" must be a non-empty string',
                request_id=raw_id,
            )

        params = payload.get("params", {})
        if not isinstance(params, dict):
            raise ProtocolError(
                ErrorCode.INVALID_REQUEST, '"params" must be an object', request_id=raw_id
            )

        return Request(id=raw_id, method=method, params=params)


@dataclass(frozen=True)
class Response:
    id: str | None
    ok: bool
    result: Mapping[str, Any] | None = None
    error: Mapping[str, str] | None = None

    @staticmethod
    def success(request_id: str, result: Mapping[str, Any]) -> Response:
        return Response(id=request_id, ok=True, result=result)

    @staticmethod
    def failure(request_id: str | None, code: str, message: str) -> Response:
        return Response(id=request_id, ok=False, error={"code": str(code), "message": message})

    def to_line(self) -> str:
        """Serializes to one line. `json.dumps` escapes embedded newlines, so a
        result or message containing "\\n" never breaks the line framing."""
        body: dict[str, Any] = {"id": self.id, "ok": self.ok}
        if self.ok:
            body["result"] = self.result
        else:
            body["error"] = self.error
        return json.dumps(body, separators=(",", ":"))
