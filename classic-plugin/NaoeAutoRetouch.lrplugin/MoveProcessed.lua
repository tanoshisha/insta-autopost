-- メニュー「処理済みの写真を移動して軽くする」
local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local Common = require "Common"

LrTasks.startAsyncTask(function()
  local ok, n = LrTasks.pcall(Common.moveProcessed)
  if not ok then return LrDialogs.message("移動でエラー", tostring(n), "critical") end
  if n == 0 then
    LrDialogs.message("NAOE 自動レタッチ", "移動する写真はありませんでした（処理済みの一覧は毎朝7時に更新されます）")
  else
    LrDialogs.message("NAOE 自動レタッチ", n .. "枚を「" .. Common.DONE_COLLECTION .. "」へ移しました")
  end
end)
