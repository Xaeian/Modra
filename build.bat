if exist .\.dist\Modra.exe ^
  del .\.dist\Modra.exe

rem Built from Modra.spec, not from flags: the spec reads app.ini, so the
rem simulator packages listed there are collected even though nothing imports
rem them by name. Flags would mean repeating that list here.
pyinstaller --noconfirm ^
  --workpath ./.build ^
  --distpath ./.dist ^
  Modra.spec
