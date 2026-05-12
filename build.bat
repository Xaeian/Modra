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