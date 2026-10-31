-- メニュー「過去の写真をレタッチし直す（一覧から次の12枚）」：classic-retouch-list.tsv の順に AI レタッチ（載せた写真はトリミングを戻す）
local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local LrProgressScope = import "LrProgressScope"
local Common = require "Common"

LrTasks.startAsyncTask(function()
  local progress = LrProgressScope({ title = "NAOE レタッチし直し" })
  local ok, n, msg = LrTasks.pcall(Common.runList, 12, progress)
  progress:done()
  if not ok then
    Common.log("エラー: " .. tostring(n))
    return LrDialogs.message("レタッチし直しでエラー", tostring(n), "critical")
  end
  LrDialogs.message("NAOE レタッチし直し", msg)
end)
