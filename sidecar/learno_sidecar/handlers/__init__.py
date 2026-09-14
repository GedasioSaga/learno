"""Wires every handler module's `register()` into one `Dispatcher`.

Add a fase's handler module here and its methods show up in
`health.check`'s capabilities automatically — the transport and dispatch
loop never change.
"""

from __future__ import annotations

from learno_sidecar.dispatcher import Dispatcher
from learno_sidecar.handlers import health


def register_all(dispatcher: Dispatcher) -> None:
    health.register(dispatcher)
