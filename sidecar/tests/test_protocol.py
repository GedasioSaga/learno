import json

import pytest

from learno_sidecar.protocol import ErrorCode, ProtocolError, Request, Response


def test_parse_valid_request_with_params() -> None:
    line = json.dumps({"id": "abc-1", "method": "health.check", "params": {"x": 1}})

    request = Request.parse(line)

    assert request.id == "abc-1"
    assert request.method == "health.check"
    assert request.params == {"x": 1}


def test_parse_defaults_missing_params_to_empty_object() -> None:
    line = json.dumps({"id": "abc-1", "method": "health.check"})

    request = Request.parse(line)

    assert request.params == {}


def test_parse_rejects_malformed_json() -> None:
    with pytest.raises(ProtocolError) as excinfo:
        Request.parse("{not json")

    assert excinfo.value.code == ErrorCode.INVALID_REQUEST
    assert excinfo.value.request_id is None


def test_parse_rejects_non_object_payload() -> None:
    with pytest.raises(ProtocolError) as excinfo:
        Request.parse(json.dumps(["not", "an", "object"]))

    assert excinfo.value.code == ErrorCode.INVALID_REQUEST


def test_parse_rejects_missing_id() -> None:
    with pytest.raises(ProtocolError) as excinfo:
        Request.parse(json.dumps({"method": "health.check"}))

    assert excinfo.value.code == ErrorCode.INVALID_REQUEST
    assert excinfo.value.request_id is None


def test_parse_rejects_missing_method_but_keeps_id_for_correlation() -> None:
    with pytest.raises(ProtocolError) as excinfo:
        Request.parse(json.dumps({"id": "abc-1"}))

    assert excinfo.value.code == ErrorCode.INVALID_REQUEST
    assert excinfo.value.request_id == "abc-1"


def test_parse_rejects_params_that_is_not_an_object() -> None:
    with pytest.raises(ProtocolError) as excinfo:
        Request.parse(json.dumps({"id": "abc-1", "method": "health.check", "params": [1, 2]}))

    assert excinfo.value.code == ErrorCode.INVALID_REQUEST
    assert excinfo.value.request_id == "abc-1"


def test_success_response_serializes_result() -> None:
    line = Response.success("abc-1", {"version": "0.1.0"}).to_line()

    assert json.loads(line) == {"id": "abc-1", "ok": True, "result": {"version": "0.1.0"}}


def test_failure_response_serializes_error() -> None:
    line = Response.failure("abc-1", ErrorCode.METHOD_NOT_FOUND, "unknown method: nope").to_line()

    assert json.loads(line) == {
        "id": "abc-1",
        "ok": False,
        "error": {"code": "method_not_found", "message": "unknown method: nope"},
    }


def test_failure_response_allows_null_id() -> None:
    line = Response.failure(None, ErrorCode.INVALID_REQUEST, "malformed JSON").to_line()

    assert json.loads(line)["id"] is None


def test_response_escapes_embedded_newlines_so_framing_survives() -> None:
    line = Response.success("abc-1", {"text": "linha 1\nlinha 2"}).to_line()

    assert "\n" not in line
    assert json.loads(line)["result"]["text"] == "linha 1\nlinha 2"
