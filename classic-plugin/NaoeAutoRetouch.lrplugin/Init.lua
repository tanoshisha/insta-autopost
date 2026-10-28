-- Classic を開いている間、10分ごとに:
--   ・処理済みの写真を「インスタ投稿（処理済み）」へ移す（常に）
--   ・自動レタッチがオンの時（メニューで切り替え）:
--       「インスタ投稿」の未レタッチ写真 と、カメラから取り込んだ未レタッチのRAW をAIレタッチ
local LrTasks = import "LrTasks"
local Common = require "Common"

LrTasks.startAsyncTask(function()
  LrTasks.sleep(90) -- 起動直後は待つ
  local fails = 0
  while true do
    local okMove, err = LrTasks.pcall(Common.moveProcessed)
    if not okMove then Common.log("移動エラー: " .. tostring(err)) end
    local ok, n = true, 0
    if Common.autoOn() then
      ok, n = LrTasks.pcall(Common.run, nil, nil)
      if ok then ok, n = LrTasks.pcall(Common.runImported, nil) end
    end
    if not ok then
      fails = fails + 1
      Common.log("自動実行エラー: " .. tostring(n))
    else
      fails = 0
    end
    -- 取り込み直後でまだ残っていそうなら早めに次へ、失敗が続く時は間隔をあける
    LrTasks.sleep(fails > 0 and math.min(3600, 600 * fails) or ((type(n) == "number" and n > 0) and 30 or 600))
  end
end)
