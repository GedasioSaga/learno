"""Health-check handler: proves the sidecar started and reports what it can do."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from learno_sidecar import __version__
from learno_sidecar.dispatcher import Dispatcher

METHOD = "health.check"


def register(dispatcher: Dispatcher) -> None:
    def handle(_params: Mapping[str, Any]) -> Mapping[str, Any]:
        # Reads the dispatcher's own registry so capabilities always match
        # what later fases have registered, without editing this handler.
        return {"version": __version__, "capabilities": dispatcher.methods()}

    dispatcher.register(METHOD, handle)
