import zipfile

import pytest

from learno_sidecar.dispatcher import Dispatcher
from learno_sidecar.handlers import apkg
from learno_sidecar.protocol import ErrorCode, Request


def _dispatcher() -> Dispatcher:
    dispatcher = Dispatcher()
    apkg.register(dispatcher)
    return dispatcher


def test_import_rejects_missing_path_param() -> None:
    response = _dispatcher().dispatch(Request(id="1", method=apkg.METHOD, params={}))

    assert response.ok is False
    assert response.error["code"] == ErrorCode.INVALID_REQUEST


def test_import_rejects_blank_path() -> None:
    response = _dispatcher().dispatch(Request(id="1", method=apkg.METHOD, params={"path": "   "}))

    assert response.ok is False
    assert response.error["code"] == ErrorCode.INVALID_REQUEST


def test_import_rejects_a_path_that_does_not_exist(tmp_path) -> None:
    missing = tmp_path / "não-existe.apkg"

    response = _dispatcher().dispatch(
        Request(id="1", method=apkg.METHOD, params={"path": str(missing)})
    )

    assert response.ok is False
    assert response.error["code"] == "apkg_invalido"


def test_import_rejects_a_file_that_is_not_a_zip(tmp_path) -> None:
    not_a_zip = tmp_path / "baralho.apkg"
    not_a_zip.write_text("isto não é um zip")

    response = _dispatcher().dispatch(
        Request(id="1", method=apkg.METHOD, params={"path": str(not_a_zip)})
    )

    assert response.ok is False
    assert response.error["code"] == "apkg_invalido"


def test_import_accepts_a_real_zip_and_proves_the_bridge_round_trip(tmp_path) -> None:
    # Fase 1 só prova a ponte — o conteúdo do .apkg (o SQLite `collection.anki2`
    # dentro do zip) só importa a partir da Fase 4, então um zip mínimo, sem
    # nenhuma entrada, já é o bastante para provar o alcance ponta a ponta.
    real_apkg = tmp_path / "baralho.apkg"
    with zipfile.ZipFile(real_apkg, "w"):
        pass

    response = _dispatcher().dispatch(
        Request(id="1", method=apkg.METHOD, params={"path": str(real_apkg)})
    )

    assert response.ok is True
    assert response.result == {"notes_imported": 0}


@pytest.mark.parametrize("bad_path", [None, 123, [], {}])
def test_import_rejects_a_non_string_path(bad_path) -> None:
    response = _dispatcher().dispatch(
        Request(id="1", method=apkg.METHOD, params={"path": bad_path})
    )

    assert response.ok is False
    assert response.error["code"] == ErrorCode.INVALID_REQUEST
