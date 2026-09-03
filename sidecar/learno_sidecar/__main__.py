"""Entry point: `python -m learno_sidecar`, and what the PyInstaller spec freezes."""

from __future__ import annotations

import sys

from learno_sidecar.dispatcher import Dispatcher
from learno_sidecar.handlers import register_all
from learno_sidecar.transport import serve


def main() -> None:
    dispatcher = Dispatcher()
    register_all(dispatcher)
    serve(dispatcher, sys.stdin, sys.stdout)


if __name__ == "__main__":
    main()
