"""Learno sidecar: a stdio JSON process the Rust core hands heavy work to.

Fase 1 ships only the transport, the request/response protocol and a health
check. Later fases add ``.apkg`` import, FSRS scheduling and PDF reading as
handlers registered in ``learno_sidecar.handlers`` — the protocol and the
stdio loop in ``transport.py`` do not change when they land.
"""

__version__ = "0.1.0"
