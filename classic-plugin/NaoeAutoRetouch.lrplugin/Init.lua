-- Classic を開いている間、10分ごとに:
--   ・処理済みの写真を「インスタ投稿（処理済み）」へ移す（常に）
--   ・「インスタ投稿」の未レタッチ写真をAIレタッチ（.work\classic\auto.on がある時だけ）
local LrTasks = import "LrTasks"
local LrFileUtils = import "LrFileUtils"
local Common = require "Common"

LrTasks.startAsyncTask(function()
  LrTasks.sleep(90) -- 起動直後は待つ
  local fails = 0
  while true do
    local okMove, err = LrTasks.pcall(Common.moveProcessed)
    if not okMove then Common.log("移動エラー: " .. tostring(err)) end
    local ok, n = true, 0
    if LrFileUtils.exists(Common.WORK .. "\\auto.on") then ok, n = LrTasks.pcall(Common.run, nil, nil) end
    if not ok then
      fails = fails + 1
      Common.log("自動実行エラー: " .. tostring(n))
    else
      fails = 0
    end
    -- 失敗が続く時は間隔をあける
    LrTasks.sleep(fails > 0 and math.min(3600, 600 * fails) or 600)
  end
end)
