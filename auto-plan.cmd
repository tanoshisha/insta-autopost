@echo off
rem Run every morning by Task Scheduler.
rem 1) Split new photos into RAW / JPEG / video folders (only when Lightroom Classic is closed)
rem 2) Select new Lightroom photos, apply re-edits, schedule flyers. Output goes to auto-plan.log
cd /d "%~dp0"
echo ==== %date% %time% ==== >> auto-plan.log
node "C:\Users\tanos\sites\lr-tools\split-raw-jpeg.js" --auto >> auto-plan.log 2>&1
node plan.js >> auto-plan.log 2>&1
