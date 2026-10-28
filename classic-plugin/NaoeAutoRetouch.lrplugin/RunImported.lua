-- メニュー「取り込んだRAWを今すぐAIレタッチ」（自動を待たずに1回分＝最大30枚）
local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local LrProgressScope = import "LrProgressScope"
local Common = require "Common"

LrTasks.startAsyncTask(function()
  local progress = LrProgressScope({ title = "NAOE AIレタッチ（取り込んだRAW）" })
  local ok, n, msg = LrTasks.pcall(Common.runImported, progress)
  progress:done()
  if not ok then
    Common.log("エラー: " .. tostring(n))
    return LrDialogs.message("AIレタッチでエラー", tostring(n), "critical")
  end
  LrDialogs.message("NAOE AIレタッチ", msg)
end)
