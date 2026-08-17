@echo off
setlocal EnableExtensions
chcp 65001 >nul
title VOID - publikowanie wersji

set "ROOT=%~dp0"
if not exist "%ROOT%package.json" set "ROOT=%~dp0Void\"
if not exist "%ROOT%package.json" set "ROOT=%~dp0..\"
if not exist "%ROOT%package.json" (
  echo BLAD: nie znaleziono repozytorium VOID.
  goto :error
)
if not exist "%ROOT%scripts\publish_release.ps1" (
  echo BLAD: brakuje scripts\publish_release.ps1.
  goto :error
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\publish_release.ps1" %*
if errorlevel 1 goto :error

echo.
echo GOTOWE: GitHub Release i podpisany plik Void.apk zostaly utworzone.
pause
exit /b 0

:error
echo.
echo Publikacja nie zostala zakonczona. Przeczytaj komunikat bledu powyzej.
pause
exit /b 1
