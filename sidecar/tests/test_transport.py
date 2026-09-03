import io
import json

from learno_sidecar.dispatcher import Dispatcher
from learno_sidecar.handlers import register_all
from learno_sidecar.transport import handle_line, serve


def _dispatcher_with_health() -> Dispatcher:
    dispatcher = Dispatcher()
    register_all(dispatcher)
    return dispatcher


def test_handle_line_returns_health_check_response() -> None:
    dispatcher = _dispatcher_with_health()
    line = json.dumps({"id": "1", "method": "health.check", "params": {}})

    response = json.loads(handle_line(dispatcher, line))

    assert response["ok"] is True
    assert response["result"]["version"]
    assert "health.check" in response["result"]["capabilities"]
    assert response["id"] == "1"


def test_handle_line_malformed_message_returns_invalid_request_with_null_id() -> None:
    response = json.loads(handle_line(_dispatcher_with_health(), "{not json at all"))

    assert response["ok"] is False
    assert response["error"]["code"] == "invalid_request"
    assert response["id"] is None


def test_handle_line_nonexistent_method_returns_method_not_found() -> None:
    line = json.dumps({"id": "2", "method": "fsrs.schedule", "params": {}})

    response = json.loads(handle_line(_dispatcher_with_health(), line))

    assert response["ok"] is False
    assert response["error"]["code"] == "method_not_found"
    assert response["id"] == "2"


def test_handle_line_round_trips_a_large_response() -> None:
    # Exercises line framing at a size that would reveal buffering/truncation
    # bugs a small fixture would hide — the sidecar will return payloads this
    # size once .apkg import and PDF reading land.
    big_text = "x" * 2_000_000
    dispatcher = Dispatcher()
    dispatcher.register("test.large", lambda _params: {"text": big_text})
    line = json.dumps({"id": "3", "method": "test.large", "params": {}})

    response_line = handle_line(dispatcher, line)
    response = json.loads(response_line)

    assert "\n" not in response_line
    assert response["ok"] is True
    assert len(response["result"]["text"]) == len(big_text)


def test_serve_processes_pipelined_requests_and_skips_blank_lines() -> None:
    dispatcher = _dispatcher_with_health()
    requests = "\n".join(
        [
            json.dumps({"id": "1", "method": "health.check", "params": {}}),
            "",
            json.dumps({"id": "2", "method": "health.check", "params": {}}),
        ]
    )
    reader = io.StringIO(requests)
    writer = io.StringIO()

    serve(dispatcher, reader, writer)

    lines = [line for line in writer.getvalue().splitlines() if line]
    assert len(lines) == 2
    assert [json.loads(line)["id"] for line in lines] == ["1", "2"]


def test_serve_stops_when_reader_is_exhausted() -> None:
    # The Rust side closes stdin on shutdown; the loop must return instead of
    # blocking, or the process would never exit.
    serve(_dispatcher_with_health(), io.StringIO(""), io.StringIO())
