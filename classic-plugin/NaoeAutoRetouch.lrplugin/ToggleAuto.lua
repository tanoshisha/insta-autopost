-- メニュー「自動レタッチのオン／オフ」
local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local LrFileUtils = import "LrFileUtils"
local Common = require "Common"

LrTasks.startAsyncTask(function()
  if Common.autoOn() then
    LrFileUtils.delete(Common.AUTO_FLAG)
    LrDialogs.message("NAOE AIレタッチ", "自動レタッチを【オフ】にしました")
  else
    local f = io.open(Common.AUTO_FLAG, "w")
    if f then f:write("on") f:close() end
    LrDialogs.message(
      "NAOE AIレタッチ",
      "自動レタッチを【オン】にしました。\nClassicを開いている間、10分ごとに次の写真をAIレタッチします:\n・カメラから D:\\現像中 に取り込んだ、未レタッチのRAW（直近14日）\n・コレクション「インスタ投稿」の未レタッチ写真\n\n※AIノイズ除去は手動です（メニュー「ノイズ除去がまだの写真を選択」）"
    )
  end
end)
