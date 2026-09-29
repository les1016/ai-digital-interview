@echo off
chcp 65001 >nul
"%~dp0.venv\Scripts\python.exe" -X utf8 "%~dp0scripts\public_release.py"
pause
