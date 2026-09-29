@echo off
chcp 65001 >nul
echo 这是源码学习模式，不启动数字人和语音服务；完整语音面试需使用一键启动。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-all.ps1" -WebOnly
if errorlevel 1 pause
