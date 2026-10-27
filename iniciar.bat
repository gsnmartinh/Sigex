@echo off
rem Inicia SIGEX 2 usando el Electron ya instalado en esta carpeta o en la carpeta superior (Exhorto-app).
cd /d "%~dp0"
if exist "node_modules\.bin\electron.cmd" (
  call "node_modules\.bin\electron.cmd" .
) else if exist "..\node_modules\.bin\electron.cmd" (
  call "..\node_modules\.bin\electron.cmd" .
) else (
  echo No se encontro Electron. Abre una terminal en esta carpeta y ejecuta: npm install
  pause
)
