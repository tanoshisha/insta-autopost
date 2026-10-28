-- 東京フォトウォークサークルの活動記録（ブログ）
--   コレクションセット「東京フォトウォークサークル（ブログ）」に、開催回ごとのコレクション「日付 第N回 タイトル」を用意する。
--   そこに写真を入れると、書き出し → AIが説明・本文を書いて → サイトに「下書き」で載る（スマホのCMSで確認して公開）。
--   すでに記事がある回に写真を足すと、その記事に写真が追加される。
local LrApplication = import "LrApplication"
local LrTasks = import "LrTasks"
local LrFileUtils = import "LrFileUtils"
local LrPathUtils = import "LrPathUtils"
local LrExportSession = import "LrExportSession"
local LrDate = import "LrDate"
local Common = require "Common"

local M = {}
M.SET = "東京フォトウォークサークル（ブログ）"
local WORK = Common.ROOT .. "\\.work\\tpw"
local PUBLISHED = WORK .. "\\published.tsv"
local seen = {} -- 自動の時は、写真を入れ終わるまで（枚数が10分変わらない）待つ: { n=枚数, t=変わった時刻 }

local function node(args)
  return LrTasks.execute('""' .. Common.NODE .. '" "' .. Common.ROOT .. '\\tpw-blog.js" ' .. args .. '"')
end

-- 開催回ごとのコレクションを用意
function M.ensureCollections()
  node("events")
  local f = io.open(Common.ROOT .. "\\classic-tpw-events.tsv", "r")
  if not f then return end
  local rows = {}
  for line in f:lines() do
    local date, vol, title = line:match("^(%S+)\t(%d+)\t(.+)$")
    if date then rows[#rows + 1] = date .. " 第" .. vol .. "回 " .. title end
  end
  f:close()
  local catalog = LrApplication.activeCatalog()
  catalog:withWriteAccessDo("TPWブログのコレクション", function()
    local set = catalog:createCollectionSet(M.SET, nil, true)
    local have = {}
    for _, c in ipairs(set:getChildCollections()) do have[c:getName():sub(1, 10)] = true end
    for _, name in ipairs(rows) do
      if not have[name:sub(1, 10)] then catalog:createCollection(name, set, true) end
    end
  end, { timeout = 60 })
end

local function loadPublished()
  local t = {}
  local f = io.open(PUBLISHED, "r")
  if f then
    for line in f:lines() do t[line] = true end
    f:close()
  end
  return t
end

-- 1回分の書き出し → 記事づくり
local function publish(date, photos)
  local dir = WORK .. "\\" .. date
  LrFileUtils.createAllDirectories(dir)
  for p in LrFileUtils.recursiveFiles(dir) do LrFileUtils.delete(p) end
  local session = LrExportSession({
    photosToExport = photos,
    exportSettings = {
      LR_export_destinationType = "specificFolder",
      LR_export_destinationPathPrefix = dir,
      LR_export_useSubfolder = false,
      LR_format = "JPEG",
      LR_jpeg_quality = 0.92,
      LR_export_colorSpace = "sRGB",
      LR_size_doConstrain = true,
      LR_size_resizeType = "longEdge",
      LR_size_maxHeight = 2400,
      LR_size_maxWidth = 2400,
      LR_size_units = "pixels",
      LR_size_resolution = 72,
      LR_outputSharpeningOn = false,
      LR_collisionHandling = "overwrite",
      LR_minimizeEmbeddedMetadata = true,
      LR_removeLocationMetadata = true,
      LR_includeVideoFiles = false,
    },
  })
  local order = {}
  for _, r in session:renditions() do
    local ok, pathOrMsg = r:waitForRender()
    if ok then
      local uuid = r.photo:getRawMetadata("uuid")
      LrFileUtils.move(pathOrMsg, LrPathUtils.child(dir, uuid .. ".jpg"))
      order[#order + 1] = { uuid = uuid, t = r.photo:getRawMetadata("dateTimeOriginal") or 0 }
    end
  end
  table.sort(order, function(a, b) return a.t < b.t end)
  local f = io.open(dir .. "\\order.tsv", "w")
  if f then
    for _, o in ipairs(order) do f:write(o.uuid, "\n") end
    f:close()
  end
  node('publish ' .. date .. ' "' .. dir .. '"')
  -- 終わった写真を記録
  local done = io.open(dir .. "\\done.tsv", "r")
  if not done then return 0 end
  local out = io.open(PUBLISHED, "a")
  local n = 0
  for line in done:lines() do
    if line ~= "" then
      out:write(line, "\n")
      n = n + 1
    end
  end
  done:close()
  out:close()
  return n
end

-- 新しく入れられた写真を記事にする。force=false（自動）の時は、枚数が10分変わらなくなってから
function M.sync(force)
  LrFileUtils.createAllDirectories(WORK)
  local catalog = LrApplication.activeCatalog()
  local set
  for _, s in ipairs(catalog:getChildCollectionSets()) do
    if s:getName() == M.SET then set = s end
  end
  if not set then return 0, "コレクションセット「" .. M.SET .. "」がありません" end
  local published = loadPublished()
  local total, msgs = 0, {}
  for _, c in ipairs(set:getChildCollections()) do
    local date = c:getName():match("^(%d%d%d%d%-%d%d%-%d%d)")
    if date then
      local fresh = {}
      for _, p in ipairs(c:getPhotos()) do
        if not published[p:getRawMetadata("uuid")] then fresh[#fresh + 1] = p end
      end
      local now = os.time()
      if not seen[date] or seen[date].n ~= #fresh then seen[date] = { n = #fresh, t = now } end
      local ready = force or (#fresh > 0 and now - seen[date].t >= 600)
      if #fresh > 0 and ready then
        local n = publish(date, fresh)
        Common.log("TPWブログ " .. date .. ": " .. n .. "枚")
        total = total + n
        msgs[#msgs + 1] = c:getName() .. "：" .. n .. "枚"
        seen[date] = nil
      end
    end
  end
  if total == 0 then return 0, "新しく記事にする写真はありません" end
  return total, table.concat(msgs, "\n") .. "\n\nサイトの管理画面（tokyo-photowalk.com/admin）の「活動記録」で確認して、「下書き」をオフにして保存すると公開されます。"
end

return M
