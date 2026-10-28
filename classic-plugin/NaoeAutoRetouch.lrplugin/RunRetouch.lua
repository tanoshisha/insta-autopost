-- メニュー「インスタ投稿を自動レタッチ」
local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local LrProgressScope = import "LrProgressScope"
local Common = require "Common"

LrTasks.startAsyncTask(function()
  local progress = LrProgressScope({ title = "NAOE 自動レタッチ：AIが写真を見ています…" })
  local ok, n, msg = LrTasks.pcall(Common.run, false)
  progress:done()
  if not ok then
    Common.log("エラー: " .. tostring(n))
    return LrDialogs.message("自動レタッチでエラー", tostring(n), "critical")
  end
  LrDialogs.message("NAOE 自動レタッチ", msg)
end)
