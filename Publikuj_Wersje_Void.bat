@echo off
setlocal EnableExtensions
chcp 65001 >nul
title VOID - publikowanie wersji

set "ROOT=%~dp0"
if not exist "%ROOT%package.json" set "ROOT=%~dp0Void\"
if not exist "%ROOT%package.json" set "ROOT=%~dp0..\"
cd /d "%ROOT%"

set /p "VERSION=Podaj wersje (np. 0.2.1): "
if "%VERSION%"=="" goto :done
set "VERSION=%VERSION:v=%"
set "TAG=v%VERSION%"

echo.
echo Ustawiam wersje %VERSION% we wszystkich manifestach...
node scripts\bump_version.cjs "%VERSION%"

echo.
echo Zapisuje i wysylam kod na GitHub...
git add -A
git commit -m "Release %TAG%"
git push origin HEAD:main

echo.
echo Nadpisuje tag %TAG% i uruchamiam release GitHub Actions...
git tag -f "%TAG%"
git push origin "%TAG%" --force

echo.
echo GOTOWE. Kod i tag %TAG% zostaly wyslane.
echo GitHub Actions zbuduje APK i utworzy release.

:done
pause
