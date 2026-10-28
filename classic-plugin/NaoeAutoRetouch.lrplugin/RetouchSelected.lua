-- メニュー「選択した写真をAIレタッチ（やり直し）」：レタッチ済みでも、選んだ写真をAIでレタッチし直す
local LrApplication = import "LrApplication"
local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local LrProgressScope = import "LrProgressScope"
local Common = require "Common"

LrTasks.startAsyncTask(function()
  local photos = LrApplication.activeCatalog():getTargetPhotos()
  if #photos == 0 then return LrDialogs.message("写真を選んでから実行してください") end
  if #photos > 40 then
    local r = LrDialogs.confirm(#photos .. "枚をAIレタッチします（時間がかかります）。よいですか？", nil, "実行", "やめる")
    if r ~= "ok" then return end
  end
  local progress = LrProgressScope({ title = "NAOE AIレタッチ（選択した写真）" })
  local ok, n, msg = LrTasks.pcall(Common.run, photos, progress)
  progress:done()
  if not ok then
    Common.log("エラー: " .. tostring(n))
    return LrDialogs.message("AIレタッチでエラー", tostring(n), "critical")
  end
  LrDialogs.message("NAOE AIレタッチ", msg)
end)
