from learno_sidecar.dispatcher import Dispatcher
from learno_sidecar.protocol import ErrorCode, ProtocolError, Request


def test_dispatch_returns_success_from_registered_handler() -> None:
    dispatcher = Dispatcher()
    dispatcher.register("echo", lambda params: {"echoed": params})
    request = Request(id="1", method="echo", params={"a": 1})

    response = dispatcher.dispatch(request)

    assert response.ok is True
    assert response.result == {"echoed": {"a": 1}}
    assert response.id == "1"


def test_dispatch_unknown_method_returns_method_not_found() -> None:
    dispatcher = Dispatcher()
    request = Request(id="1", method="does.not.exist", params={})

    response = dispatcher.dispatch(request)

    assert response.ok is False
    assert response.error is not None
    assert response.error["code"] == ErrorCode.METHOD_NOT_FOUND
    assert response.id == "1"


def test_dispatch_handler_protocol_error_keeps_its_code() -> None:
    def failing_handler(_params: dict) -> dict:
        raise ProtocolError("apkg_invalido", "arquivo corrompido")

    dispatcher = Dispatcher()
    dispatcher.register("apkg.import", failing_handler)
    request = Request(id="1", method="apkg.import", params={})

    response = dispatcher.dispatch(request)

    assert response.ok is False
    assert response.error["code"] == "apkg_invalido"
    assert response.error["message"] == "arquivo corrompido"


def test_dispatch_handler_crash_becomes_internal_error_not_a_raised_exception() -> None:
    def crashing_handler(_params: dict) -> dict:
        raise ValueError("bug inesperado")

    dispatcher = Dispatcher()
    dispatcher.register("boom", crashing_handler)
    request = Request(id="1", method="boom", params={})

    response = dispatcher.dispatch(request)

    assert response.ok is False
    assert response.error["code"] == ErrorCode.INTERNAL_ERROR
    assert "bug inesperado" in response.error["message"]


def test_methods_lists_every_registered_method_sorted() -> None:
    dispatcher = Dispatcher()
    dispatcher.register("z.last", lambda params: {})
    dispatcher.register("a.first", lambda params: {})

    assert dispatcher.methods() == ["a.first", "z.last"]
