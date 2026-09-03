from learno_sidecar import __version__
from learno_sidecar.dispatcher import Dispatcher
from learno_sidecar.handlers import health
from learno_sidecar.protocol import Request


def test_health_check_reports_version_and_itself_as_a_capability() -> None:
    dispatcher = Dispatcher()
    health.register(dispatcher)

    response = dispatcher.dispatch(Request(id="1", method=health.METHOD, params={}))

    assert response.ok is True
    assert response.result == {"version": __version__, "capabilities": ["health.check"]}


def test_health_check_capabilities_reflect_everything_registered() -> None:
    dispatcher = Dispatcher()
    health.register(dispatcher)
    dispatcher.register("fsrs.schedule", lambda params: {})

    response = dispatcher.dispatch(Request(id="1", method=health.METHOD, params={}))

    assert response.result["capabilities"] == ["fsrs.schedule", "health.check"]
