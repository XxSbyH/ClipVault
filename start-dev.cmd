@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "MODE=%~1"
if "%MODE%"=="" set "MODE=dev"

if /I not "%MODE%"=="dev" if /I not "%MODE%"=="build" if /I not "%MODE%"=="check" (
  echo Usage:
  echo   start-dev.cmd         Start Tauri dev mode
  echo   start-dev.cmd build   Build the installer
  echo   start-dev.cmd check   Check local environment only
  exit /b 2
)

set "RJ_ROOT=D:\rj"
set "RUSTUP_HOME=%RJ_ROOT%\rustup"
set "CARGO_HOME=%RJ_ROOT%\cargo"
set "PNPM_STORE=%RJ_ROOT%\pnpm-store"
set "TAURI_TOOLS=%RJ_ROOT%\tauri-tools"
set "LOCALAPPDATA=%RJ_ROOT%\tauri-localappdata"
set "XDG_CACHE_HOME=%RJ_ROOT%\tauri-cache"
set "TEMP=%RJ_ROOT%\tauri-temp"
set "TMP=%RJ_ROOT%\tauri-temp"
set "PATH=%CARGO_HOME%\bin;%PATH%"

if not exist "%RJ_ROOT%" mkdir "%RJ_ROOT%"
if not exist "%RUSTUP_HOME%" mkdir "%RUSTUP_HOME%"
if not exist "%CARGO_HOME%" mkdir "%CARGO_HOME%"
if not exist "%PNPM_STORE%" mkdir "%PNPM_STORE%"
if not exist "%TAURI_TOOLS%" mkdir "%TAURI_TOOLS%"
if not exist "%LOCALAPPDATA%" mkdir "%LOCALAPPDATA%"
if not exist "%XDG_CACHE_HOME%" mkdir "%XDG_CACHE_HOME%"
if not exist "%TEMP%" mkdir "%TEMP%"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo ERROR: pnpm was not found in PATH.
  echo Install pnpm first, then run this script again.
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo ERROR: cargo was not found in PATH.
  echo Expected cargo under %CARGO_HOME%\bin.
  exit /b 1
)

if not exist "src-tauri\target" mkdir "src-tauri\target"
if not exist "src-tauri\target\.tauri" (
  mklink /J "src-tauri\target\.tauri" "%TAURI_TOOLS%" >nul
  if errorlevel 1 (
    echo ERROR: failed to create src-tauri\target\.tauri junction.
    echo Target should be %TAURI_TOOLS%.
    exit /b 1
  )
)

if not exist "node_modules" (
  if /I "%MODE%"=="check" (
    echo WARN: node_modules is missing. Run start-dev.cmd to install dependencies.
  ) else (
    echo node_modules is missing. Installing dependencies with store %PNPM_STORE% ...
    pnpm install --store-dir "%PNPM_STORE%"
    if errorlevel 1 exit /b %ERRORLEVEL%
  )
)

if /I "%MODE%"=="check" (
  echo Environment check completed.
  echo Project: %CD%
  echo Rustup: %RUSTUP_HOME%
  echo Cargo: %CARGO_HOME%
  echo pnpm store: %PNPM_STORE%
  echo Tauri tools: %TAURI_TOOLS%
  exit /b 0
)

if /I "%MODE%"=="build" (
  echo Building ClipVault installer...
  pnpm build
  exit /b %ERRORLEVEL%
)

echo Starting ClipVault Tauri dev mode...
pnpm tauri:dev
exit /b %ERRORLEVEL%
