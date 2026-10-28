-- メニュー「TPWブログに今すぐ反映」：コレクションを用意して、入れた写真を記事（下書き）にする
local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local LrProgressScope = import "LrProgressScope"
local Common = require "Common"
local Tpw = require "Tpw"

LrTasks.startAsyncTask(function()
  local progress = LrProgressScope({ title = "TPWブログ：写真を書き出してAIが記事を書いています…" })
  local ok, err = LrTasks.pcall(Tpw.ensureCollections)
  if not ok then Common.log("TPWコレクション: " .. tostring(err)) end
  local ok2, n, msg = LrTasks.pcall(Tpw.sync, true)
  progress:done()
  if not ok2 then return LrDialogs.message("TPWブログでエラー", tostring(n), "critical") end
  LrDialogs.message("TPWブログ", msg)
end)
