pip show pyinstaller > nul 2>&1 ^
  || pip install -U pyinstaller

if exist .\.dist\Modra.exe ^
  del .\.dist\Modra.exe

pyinstaller --onefile ^
  --workpath ./.build ^
  --distpath ./.dist ^
  --name Modra ^
  --icon=favicon.ico ^
  --add-data "favicon.ico;." ^
  --add-data "index.html;." ^
  api.py