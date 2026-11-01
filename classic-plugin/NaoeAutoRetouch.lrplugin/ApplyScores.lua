-- メニュー「AIの点数を星にする（クラウドでも見える）」
local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local Common = require "Common"

LrTasks.startAsyncTask(function()
  local ok, n = LrTasks.pcall(Common.applyScores)
  if not ok then
    Common.log("点数を星に: " .. tostring(n))
    return LrDialogs.message("点数を星に", tostring(n), "critical")
  end
  LrDialogs.message("点数を星に", n .. "枚に星を付けました（9点=★5〜5点=★1。自分で付けた星はそのまま）。クラウドには同期で順に反映されます。")
end)
