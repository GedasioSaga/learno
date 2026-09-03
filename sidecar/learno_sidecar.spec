# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Learno sidecar.

Builds one onefile executable so the result is a single binary to copy into
`src-tauri/binaries/` under Tauri's externalBin naming convention. See
`sidecar/README.md` for the exact build command, the output path and the
target-triple renaming Tauri requires.

`SPECPATH` below is injected by PyInstaller when it execs this file — it is
not a normal Python import.
"""

from pathlib import Path

project_root = Path(SPECPATH)  # noqa: F821 - PyInstaller-injected global

a = Analysis(  # noqa: F821 - PyInstaller-injected global
    [str(project_root / "learno_sidecar" / "__main__.py")],
    pathex=[str(project_root)],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data)  # noqa: F821 - PyInstaller-injected global

exe = EXE(  # noqa: F821 - PyInstaller-injected global
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="learno-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    # The bridge talks to this process over stdio; a windowed/no-console
    # build would have no stdin/stdout to speak the protocol on.
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
