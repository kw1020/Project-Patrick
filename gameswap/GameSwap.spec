# PyInstaller recipe for GameSwap.exe. Build it with build_exe.bat.
# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

datas = [("gameswap/overlay_pages", "gameswap/overlay_pages"), ("gameswap/assets", "gameswap/assets")]
binaries = []
hiddenimports = ["win32timezone"]
# uiautomation / comtypes load parts of themselves at runtime; take all of them.
for package in ("uiautomation", "comtypes"):
    try:
        d, b, h = collect_all(package)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception as e:
        print(f"note: couldn't collect {package}: {e}")

a = Analysis(
    ["gameswap_launcher.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest", "websockets", "PySide6.QtWebEngineCore", "PySide6.Qt3DCore"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="GameSwap",
    console=False,  # a normal window app, no black console window
    icon="gameswap/assets/gameswap.ico",
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="GameSwap", upx=False)
