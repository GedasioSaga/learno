"""`apkg.import` handler: proves the Rust<->sidecar bridge round-trips a real
request end to end.

Reading the zip's contents, decoding the embedded SQLite collection, and
converting notes/cards to Learno's schema is Fase 4 — this handler only
checks that `path` points to a real `.apkg` (a zip archive) before answering,
so PLT-004's bridge can be proven without pulling in Fase 4's import logic.
`notes_imported` is always 0 until that logic exists.
"""

from __future__ import annotations

import zipfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from learno_sidecar.dispatcher import Dispatcher
from learno_sidecar.protocol import ErrorCode, ProtocolError

METHOD = "apkg.import"

# Stable, sidecar-specific code — kept out of `protocol.ErrorCode` because
# that enum only holds transport-level categories every method shares.
_APKG_INVALIDO = "apkg_invalido"


def register(dispatcher: Dispatcher) -> None:
    def handle(params: Mapping[str, Any]) -> Mapping[str, Any]:
        path = params.get("path")
        if not isinstance(path, str) or not path.strip():
            raise ProtocolError(ErrorCode.INVALID_REQUEST, "params.path é obrigatório")

        apkg_path = Path(path)
        if not apkg_path.is_file():
            raise ProtocolError(_APKG_INVALIDO, f"arquivo não encontrado: {path}")

        if not zipfile.is_zipfile(apkg_path):
            raise ProtocolError(_APKG_INVALIDO, f"não é um pacote .apkg válido: {path}")

        return {"notes_imported": 0}

    dispatcher.register(METHOD, handle)
