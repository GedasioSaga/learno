"""Learno sidecar: a stdio JSON process the Rust core hands heavy work to.

It ships the transport, the request/response protocol and a health check.
Heavy work that needs Python lands as handlers registered in
``learno_sidecar.handlers`` — the protocol and the stdio loop in
``transport.py`` do not change when it does. ``.apkg`` import is not one of
them: it moved to Rust (``src-tauri/src/anki``), where the database lives.
"""

__version__ = "0.1.0"
