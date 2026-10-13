@echo off
setlocal
cd /d "%~dp0"

rem Usa um Python entre 3.10 e 3.14. Versoes mais novas ainda nao tem
rem pacotes prontos de algumas dependencias (pydantic-core) para Windows.
set "PY="
for %%V in (3.13 3.12 3.14 3.11 3.10) do (
  if not defined PY (
    py -%%V -c "import sys" >nul 2>&1 && set "PY=py -%%V"
  )
)
if not defined PY (
  echo.
  echo Nao encontrei um Python entre 3.10 e 3.14 neste computador.
  echo Instale o Python 3.13 com o comando abaixo no PowerShell e rode este arquivo de novo:
  echo.
  echo     winget install -e --id Python.Python.3.13
  echo.
  pause
  exit /b 1
)

if not exist .venv\Scripts\python.exe goto criar
.venv\Scripts\python -c "import flask, instagrapi" >nul 2>&1 && goto rodar
echo Ambiente incompleto ou de uma instalacao anterior, recriando...
rmdir /s /q .venv

:criar
echo Preparando o ambiente pela primeira vez usando %PY% ...
%PY% -m venv .venv || goto erro
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install --only-binary=:all: -r requirements.txt || goto erro

:rodar
.venv\Scripts\python app.py
pause
exit /b 0

:erro
echo.
echo Deu erro na instalacao. Tire um print desta janela e mande.
if exist .venv rmdir /s /q .venv
pause
exit /b 1
