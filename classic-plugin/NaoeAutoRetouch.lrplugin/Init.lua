-- Classic を開いている間、10分ごとに（auto.on がある時だけ）「インスタ投稿」の未レタッチ写真を見て、あれば自動でレタッチする
local LrTasks = import "LrTasks"
local LrFileUtils = import "LrFileUtils"
local Common = require "Common"

LrTasks.startAsyncTask(function()
  LrTasks.sleep(60) -- 起動直後は待つ
  local fails = 0
  while true do
    -- 自動実行は .work\classic\auto.on があるときだけ（最初は手動で確かめてから有効にする）
    local ok, n = true, 0
    if LrFileUtils.exists(Common.WORK .. "\\auto.on") then ok, n = LrTasks.pcall(Common.run, true) end
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
