-- メニュー「インスタ投稿を自動レタッチ」：コレクション「インスタ投稿」の未レタッチ写真をAIレタッチ
local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local LrProgressScope = import "LrProgressScope"
local Common = require "Common"

LrTasks.startAsyncTask(function()
  local progress = LrProgressScope({ title = "NAOE AIレタッチ" })
  local ok, n, msg = LrTasks.pcall(Common.run, nil, progress)
  progress:done()
  if not ok then
    Common.log("エラー: " .. tostring(n))
    return LrDialogs.message("AIレタッチでエラー", tostring(n), "critical")
  end
  LrDialogs.message("NAOE AIレタッチ", msg)
end)
