# -*- mode: python ; coding: utf-8 -*-

# Built from this file rather than from `pyinstaller` flags, because the coupled
# simulator packages are imported by name at runtime and the analyser cannot see
# them. The list is read from the same `app.ini` line the app reads instead of
# being repeated here, so a build for another device stays one new package plus
# one line in one file, and a build for none leaves this empty.

import os
from xaeian import INI

SIM = [n.strip() for n in
  str(INI.load(os.path.join(SPECPATH, 'app.ini')).get('sim', '') or '').split(',')
  if n.strip()]

a = Analysis(
  ['api.py'],
  pathex=[],
  binaries=[],
  datas=[('favicon.ico', '.'), ('index.html', '.'), ('app.ini', '.')],
  hiddenimports=SIM,
  hookspath=[],
  hooksconfig={},
  runtime_hooks=[],
  excludes=[],
  noarchive=False,
  optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
  pyz,
  a.scripts,
  a.binaries,
  a.datas,
  [],
  name='Modra',
  debug=False,
  bootloader_ignore_signals=False,
  strip=False,
  upx=False,
  upx_exclude=[],
  runtime_tmpdir=None,
  console=False,
  disable_windowed_traceback=False,
  argv_emulation=False,
  target_arch=None,
  codesign_identity=None,
  entitlements_file=None,
  icon=['favicon.ico'],
)
