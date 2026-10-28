@echo off
rem Run every morning by Task Scheduler: select new Lightroom photos, apply re-edits, schedule flyers. Output goes to auto-plan.log
cd /d "%~dp0"
echo ==== %date% %time% ==== >> auto-plan.log
node plan.js >> auto-plan.log 2>&1
