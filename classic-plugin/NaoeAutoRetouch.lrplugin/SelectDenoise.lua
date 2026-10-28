-- メニュー「インスタ投稿でノイズ除去がまだの写真を選択」
-- AIノイズ除去はプラグインから実行できない（Lightroomが画像を計算するため）ので、対象の写真をまとめて選ぶところまで。
-- このあと 写真 → 強化（Ctrl+Alt+I）→ ノイズ除去 で、選んだ写真に一括でかけられる。
local LrApplication = import "LrApplication"
local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local Common = require "Common"

LrTasks.startAsyncTask(function()
  local catalog = LrApplication.activeCatalog()
  local col = Common.findCollection(catalog)
  if not col then return LrDialogs.message("コレクション「" .. Common.COLLECTION .. "」が見つかりません") end
  local list = {}
  for _, p in ipairs(col:getPhotos()) do
    if Common.needsDenoise(p) then list[#list + 1] = p end
  end
  if #list == 0 then return LrDialogs.message("NAOE 自動レタッチ", "ノイズ除去がまだの写真はありません") end
  catalog:setActiveSources({ col })
  LrTasks.sleep(0.5)
  catalog:setSelectedPhotos(list[1], list)
  LrDialogs.message(
    "NAOE 自動レタッチ",
    #list .. "枚を選びました。\nこのまま「写真」→「強化…」（Ctrl+Alt+I）→「ノイズ除去」でまとめてかけられます。"
  )
end)
