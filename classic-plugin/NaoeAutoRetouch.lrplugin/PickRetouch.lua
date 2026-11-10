-- メニュー「指定した写真をAIレタッチ → TPW活動記録」
--   classic-pick.tsv（1行目: 撮影日 YYYY-MM-DD、2行目以降: ファイル名（拡張子なし））の写真だけを
--   AIレタッチして、その回の TPW ブログのコレクションに入れ、活動記録（下書き）を作る。
--   取り込んだ全部ではなく、選んだ写真だけにトークンを使うためのメニュー。
local LrApplication = import "LrApplication"
local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local LrFileUtils = import "LrFileUtils"
local LrProgressScope = import "LrProgressScope"
local Common = require "Common"
local Tpw = require "Tpw"

local PICK = Common.ROOT .. "\\classic-pick.tsv"

LrTasks.startAsyncTask(function()
  local f = io.open(PICK, "r")
  if not f then return LrDialogs.message("指定リスト（classic-pick.tsv）がありません") end
  local date, want, order = nil, {}, {}
  for line in f:lines() do
    line = line:gsub("%s+$", "")
    if not date then date = line:match("^(%d%d%d%d%-%d%d%-%d%d)")
    elseif line ~= "" then want[line:upper()] = true order[#order + 1] = line end
  end
  f:close()
  if not date or #order == 0 then return LrDialogs.message("指定リストの形式が違います") end

  local catalog = LrApplication.activeCatalog()
  local photos = {}
  local function walk(folder)
    if folder:getName() == date then
      for _, p in ipairs(folder:getPhotos(false)) do
        local name = (p:getFormattedMetadata("fileName") or ""):gsub("%.[^%.]+$", ""):upper()
        if want[name] then photos[#photos + 1] = p want[name] = nil end
      end
      return
    end
    for _, c in ipairs(folder:getChildren()) do walk(c) end
  end
  for _, fo in ipairs(catalog:getFolders()) do walk(fo) end
  if #photos == 0 then return LrDialogs.message(date .. " の指定の写真が見つかりません") end
  local missing = {}
  for k in pairs(want) do missing[#missing + 1] = k end

  local progress = LrProgressScope({ title = "NAOE：指定した写真をAIレタッチ → TPW活動記録" })
  -- レタッチ済みの写真はやり直さない（トークン節約）。全部済みならレタッチは飛ばして記事だけ作る
  local todo = {}
  for _, p in ipairs(photos) do
    if Common.isUnedited(p) then todo[#todo + 1] = p end
  end
  local msg = "レタッチ済みなので、レタッチはしていません"
  if #todo > 0 then
    Common.log("指定レタッチ " .. date .. ": " .. #todo .. "枚")
    local ok, n, m = LrTasks.pcall(Common.run, todo, progress)
    if not ok then
      progress:done()
      Common.log("エラー: " .. tostring(n))
      return LrDialogs.message("AIレタッチでエラー", tostring(n), "critical")
    end
    msg = m
  end

  -- 書き出して活動記録（下書き）を作る（コレクションは使わない）
  progress:setCaption("活動記録を作っています（書き出し → AIが本文を書く）…")
  local ok2, n2 = LrTasks.pcall(Tpw.publish, date, photos)
  local blog = ok2 and ("活動記録に " .. tostring(n2) .. "枚を載せました（下書き）") or ("活動記録でエラー: " .. tostring(n2))
  Common.log("指定 → TPW活動記録 " .. date .. ": " .. blog)
  progress:done()
  if LrFileUtils.exists(PICK .. ".done") then LrFileUtils.delete(PICK .. ".done") end
  LrFileUtils.move(PICK, PICK .. ".done")
  LrDialogs.message("NAOE 指定レタッチ", tostring(msg) .. "\n\n" .. blog .. (#missing > 0 and ("\n\n見つからなかった写真: " .. table.concat(missing, ", ")) or ""))
end)
