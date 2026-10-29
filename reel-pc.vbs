' Run every 10 minutes by Task Scheduler: make reel videos with After Effects (no console window)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\tanos\sites\insta-autopost"
sh.Run "cmd /c ""C:\Program Files\nodejs\node.exe"" reel-pc.js >> .work\reel-pc.log 2>&1", 0, False
