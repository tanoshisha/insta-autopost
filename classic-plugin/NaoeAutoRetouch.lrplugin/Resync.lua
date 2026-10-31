-- メニュー「同期が止まった写真をやり直す」：classic-resync.txt（PC の find-stuck-sync.js が作る。1行1つの写真UUID）の写真を、
--   入っているコレクションから一度外して、少し待ってから入れ直す（Lightroom の同期が止まった時の定番の直し方）
local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local LrApplication = import "LrApplication"
local Common = require "Common"

LrTasks.startAsyncTask(function()
  local f = io.open(Common.ROOT .. "\\classic-resync.txt", "r")
  if not f then return LrDialogs.message("同期のやり直し", "一覧がありません（PCで find-stuck-sync.js を実行してください）") end
  local catalog = LrApplication.activeCatalog()
  local items = {}
  for line in f:lines() do
    local u = line:match("^(%S+)")
    if u then
      local p = catalog:findPhotoByUuid(u)
      if p then items[#items + 1] = { photo = p, cols = p:getContainedCollections() } end
    end
  end
  f:close()
  if #items == 0 then return LrDialogs.message("同期のやり直し", "止まっている写真は見つかりませんでした") end
  catalog:withWriteAccessDo("同期のやり直し（外す）", function()
    for _, it in ipairs(items) do
      for _, c in ipairs(it.cols) do c:removePhotos({ it.photo }) end
    end
  end, { timeout = 60 })
  LrTasks.sleep(15)
  catalog:withWriteAccessDo("同期のやり直し（入れ直す）", function()
    for _, it in ipairs(items) do
      for _, c in ipairs(it.cols) do c:addPhotos({ it.photo }) end
    end
  end, { timeout = 60 })
  Common.log("同期のやり直し: " .. #items .. "枚")
  LrDialogs.message("同期のやり直し", #items .. "枚を、入っていたコレクションから外して入れ直しました。数分で同期が動くはずです。")
end)
