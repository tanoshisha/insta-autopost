@echo off
rem 毎朝タスクスケジューラから実行：Lightroomの新しい写真の選定・再編集の反映・フライヤーの予約（画面は出さずに記録だけ）
cd /d "%~dp0"
echo ==== %date% %time% ==== >> auto-plan.log
node plan.js >> auto-plan.log 2>&1
