-- Classic を開いている間、10分ごとに:
--   ・処理済みの写真を「インスタ投稿（処理済み）」へ移す（常に）
--   ・TPWブログ：開催回のコレクションを用意し、入れ終わった写真（10分変化なし）を記事の下書きにする（常に）
--   ・自動レタッチがオンの時（メニューで切り替え）:
--       「インスタ投稿」の未レタッチ写真 と、カメラから取り込んだ未レタッチのRAW をAIレタッチ
local LrTasks = import "LrTasks"
local Common = require "Common"
local Tpw = require "Tpw"

LrTasks.startAsyncTask(function()
  LrTasks.sleep(90) -- 起動直後は待つ
  local fails, loops = 0, 0
  while true do
    local okMove, err = LrTasks.pcall(Common.moveProcessed)
    if not okMove then Common.log("移動エラー: " .. tostring(err)) end
    if loops % 36 == 0 then -- コレクションの用意は6時間に1回で十分
      local okE, errE = LrTasks.pcall(Tpw.ensureCollections)
      if not okE then Common.log("TPWコレクション: " .. tostring(errE)) end
    end
    local okT, errT = LrTasks.pcall(Tpw.sync, false)
    if not okT then Common.log("TPWブログ: " .. tostring(errT)) end
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
    loops = loops + 1
    -- 取り込み直後でまだ残っていそうなら早めに次へ、失敗が続く時は間隔をあける
    LrTasks.sleep(fails > 0 and math.min(3600, 600 * fails) or ((type(n) == "number" and n > 0) and 30 or 600))
  end
end)
