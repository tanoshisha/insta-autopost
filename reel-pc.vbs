' 10分ごとにタスクスケジューラから：リールの動画を After Effects で作る（黒い画面を出さずに動かす）
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\tanos\sites\insta-autopost"
sh.Run "cmd /c ""C:\Program Files\nodejs\node.exe"" reel-pc.js >> .work\reel-pc.log 2>&1", 0, False
