@echo off
rem Run every morning by Task Scheduler.
rem 1) Split new photos into RAW / JPEG / video folders (only when Lightroom Classic is closed)
rem 2) Select new Lightroom photos, apply re-edits, schedule flyers. Output goes to auto-plan.log
cd /d "%~dp0"
echo ==== %date% %time% ==== >> auto-plan.log
node "C:\Users\tanos\sites\lr-tools\split-raw-jpeg.js" --auto >> auto-plan.log 2>&1
node plan.js >> auto-plan.log 2>&1
rem 3) Reels: collect Lightroom Classic photos (no people), let AI judge new ones, book one reel per day for the next 7 days
node lr-pick.js --all >> auto-plan.log 2>&1
node lr-ai-pick.js >> auto-plan.log 2>&1
node lr-reels.js 3 --auto >> auto-plan.log 2>&1
rem 4) Make reel videos with After Effects (new reels / rebuilds requested from the app)
node reel-pc.js >> auto-plan.log 2>&1
