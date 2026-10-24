@echo off
setlocal DisableDelayedExpansion
if not exist "%~dp0runtime\node.exe" (
  echo Candidate runtime missing. See docs\CANDIDATE_V0.3.md.
  pause
  exit /b 1
)
if not exist "%~dp0runtime\LICENSE" (
  echo Candidate runtime license missing. See docs\CANDIDATE_V0.3.md.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0app\server.mjs"
if errorlevel 1 pause
endlocal
