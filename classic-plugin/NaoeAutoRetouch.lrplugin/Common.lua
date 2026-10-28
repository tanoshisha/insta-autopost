-- 共通処理：コレクション探し・未レタッチ/ノイズ除去の判定・AIレタッチ（PCの node + claude）
-- AIレタッチの流れ:
--   ① 写真をLightroomで書き出す（今の見た目そのまま）→ AIが1枚ずつ見て現像設定を決める（白飛び等は数値でも確認）
--   ② 当てる（ポートレートは肌のマスク入りのプリセットを土台に）
--   ③ レタッチ後をもう一度書き出す → AIがプロの目でチェックして仕上げの修正（2回まで）
local LrApplication = import "LrApplication"
local LrTasks = import "LrTasks"
local LrFileUtils = import "LrFileUtils"
local LrPathUtils = import "LrPathUtils"
local LrDate = import "LrDate"
local LrExportSession = import "LrExportSession"

local M = {}
M.COLLECTION = "インスタ投稿"
M.ROOT = "C:\\Users\\tanos\\sites\\insta-autopost"
M.WORK = M.ROOT .. "\\.work\\classic"
M.NODE = "C:\\Program Files\\nodejs\\node.exe"
M.PRESET_PORTRAIT = "NAOE ポートレート"
M.PRESET_SNAP = "NAOE スナップ"
M.REVIEWS = 2 -- 仕上げチェックの回数

-- AIに「今の設定」として見せる項目
local CUR_KEYS = {
  "Exposure2012", "Contrast2012", "Highlights2012", "Shadows2012", "Whites2012", "Blacks2012",
  "Texture", "Clarity2012", "Dehaze", "Vibrance", "Saturation", "Temperature", "Tint", "PostCropVignetteAmount",
  "ParametricShadows", "ParametricDarks", "ParametricLights", "ParametricHighlights",
  "SaturationAdjustmentOrange", "LuminanceAdjustmentOrange", "SaturationAdjustmentBlue", "LuminanceAdjustmentBlue",
  "SaturationAdjustmentGreen", "SplitToningShadowHue", "SplitToningShadowSaturation", "SplitToningHighlightHue",
  "SplitToningHighlightSaturation",
}

local function log(msg)
  local f = io.open(M.WORK .. "\\plugin.log", "a")
  if f then
    f:write(LrDate.timeToUserFormat(LrDate.currentTime(), "%Y-%m-%d %H:%M:%S"), "  ", msg, "\n")
    f:close()
  end
end
M.log = log

-- コレクション「インスタ投稿」を探す（「Lightroomから」などのセットの中も）
function M.findCollection(catalog)
  local function walk(parent)
    for _, c in ipairs(parent:getChildCollections()) do
      if c:getName() == M.COLLECTION then return c end
    end
    for _, s in ipairs(parent:getChildCollectionSets()) do
      local hit = walk(s)
      if hit then return hit end
    end
  end
  return walk(catalog)
end

-- 未レタッチ＝ライト・効果をまだ触っていない（ノイズ除去やシャープは関係なし）
local function zero(v) return v == nil or tonumber(v) == 0 end
function M.isUnedited(photo)
  if photo:getRawMetadata("isVirtualCopy") then return false end
  local s = photo:getDevelopSettings()
  return zero(s.Highlights2012) and zero(s.Shadows2012) and zero(s.Blacks2012) and zero(s.Whites2012)
    and zero(s.Contrast2012) and zero(s.Texture) and zero(s.Clarity2012)
end

-- AIノイズ除去がまだか（RAWだけ。ノイズ除去は FilterList に Name=Enhance として入る）
function M.needsDenoise(photo)
  if photo:getRawMetadata("isVirtualCopy") then return false end
  if photo:getRawMetadata("fileFormat") ~= "RAW" then return false end
  local fl = photo:getDevelopSettings().FilterList
  for _, f in pairs((fl and fl.Filters) or {}) do
    if type(f) == "table" and f.Name == "Enhance" then return false end
  end
  return true
end

local function findPreset(name)
  for _, folder in ipairs(LrApplication.developPresetFolders()) do
    for _, p in ipairs(folder:getDevelopPresets()) do
      if p:getName() == name then return p end
    end
  end
end

local function clearDir(dir)
  LrFileUtils.createAllDirectories(dir)
  for f in LrFileUtils.files(dir) do LrFileUtils.delete(f) end
end

-- 今の現像設定で書き出す（長辺1200px）。ファイル名＝写真のID
local function render(photos, dir, withCur)
  clearDir(dir)
  local session = LrExportSession({
    photosToExport = photos,
    exportSettings = {
      LR_export_destinationType = "specificFolder",
      LR_export_destinationPathPrefix = dir,
      LR_export_useSubfolder = false,
      LR_format = "JPEG",
      LR_jpeg_quality = 0.9,
      LR_export_colorSpace = "sRGB",
      LR_size_doConstrain = true,
      LR_size_resizeType = "longEdge",
      LR_size_maxHeight = 1200,
      LR_size_maxWidth = 1200,
      LR_size_units = "pixels",
      LR_size_resolution = 72,
      LR_outputSharpeningOn = false,
      LR_collisionHandling = "overwrite",
      LR_minimizeEmbeddedMetadata = true,
      LR_removeLocationMetadata = true,
      LR_includeVideoFiles = false,
    },
  })
  for _, r in session:renditions() do
    local ok, pathOrMsg = r:waitForRender()
    if ok then
      local id = tostring(r.photo.localIdentifier)
      LrFileUtils.move(pathOrMsg, LrPathUtils.child(dir, id .. ".jpg"))
      if withCur then
        local s = r.photo:getDevelopSettings()
        local f = io.open(LrPathUtils.child(dir, id .. ".cur"), "w")
        if f then
          for _, k in ipairs(CUR_KEYS) do
            if s[k] ~= nil then f:write(k, "=", tostring(s[k]), "\n") end
          end
          f:close()
        end
      end
    else
      log("書き出し失敗: " .. tostring(pathOrMsg))
    end
  end
end

-- AIに判断させる（mode = "plan" | "review"）。戻り値 { [ID] = { portrait=bool, kv={Key=数値} } }
local function askAI(mode, dir)
  local cmd = '""' .. M.NODE .. '" "' .. M.ROOT .. '\\classic-ai-retouch.js" ' .. mode .. ' "' .. dir .. '""'
  local code = LrTasks.execute(cmd)
  local f = io.open(dir .. "\\result.tsv", "r")
  if not f then return nil, "AIの結果がありません（終了コード " .. tostring(code) .. "）。.work\\classic\\retouch.log を確認" end
  local out = {}
  for line in f:lines() do
    local id, kind, rest = line:match("^(%S+)\t([PS])\t?(.*)$")
    if id then
      local kv = {}
      for k, v in (rest or ""):gmatch("([%w]+)=([%-%d%.]+)") do kv[k] = tonumber(v) end
      out[id] = { portrait = kind == "P", kv = kv }
    end
  end
  f:close()
  return out
end

-- 設定を当てる（TempDelta/TintDelta は今の色温度/色かぶりからの差）
local function applyKV(photo, kv)
  local t = {}
  local cur = photo:getDevelopSettings()
  for k, v in pairs(kv) do
    if k == "TempDelta" then
      if v ~= 0 then
        t.WhiteBalance = "Custom"
        t.Temperature = math.floor((tonumber(cur.Temperature) or 5500) + v + 0.5)
        t.Tint = t.Tint or tonumber(cur.Tint) or 0
      end
    elseif k == "TintDelta" then
      if v ~= 0 then
        t.WhiteBalance = "Custom"
        t.Temperature = t.Temperature or tonumber(cur.Temperature) or 5500
        t.Tint = math.floor((tonumber(cur.Tint) or 0) + v + 0.5)
      end
    else
      t[k] = v
    end
  end
  if next(t) then photo:applyDevelopSettings(t) end
end

-- 処理済み（予約・見送り・投稿済みになった）写真を「インスタ投稿（処理済み）」へ移して、「インスタ投稿」を軽くする。
-- 一覧は PC の plan.js が毎朝 classic-processed.tsv に書く（ファイル名 \t 撮影日時の分まで）。
-- 同期中の写真はコレクションから外しても同期は続くので、Classicで編集し直せば予約の画像にも反映される。
M.DONE_COLLECTION = "インスタ投稿（処理済み）"
function M.moveProcessed()
  local f = io.open(M.ROOT .. "\\classic-processed.tsv", "r")
  if not f then return 0 end
  -- 照合は「ファイル名の頭（拡張子や -強化-NR などを除く）＋撮影日」。日付が取れない写真はファイル名の頭だけ
  local function base(name) return (tostring(name):match("^([^%.%-_ ]+)") or tostring(name)):upper() end
  local keys, names = {}, {}
  for line in f:lines() do
    local name, date = line:match("^([^\t]+)\t(%S+)")
    if name then
      keys[base(name) .. "|" .. date:sub(1, 10)] = true
      names[base(name)] = (names[base(name)] or 0) + 1
    end
  end
  f:close()
  local catalog = LrApplication.activeCatalog()
  local col = M.findCollection(catalog)
  if not col then return 0 end
  local list, miss = {}, {}
  for _, p in ipairs(col:getPhotos()) do
    local b = base(p:getFormattedMetadata("fileName"))
    local t = p:getRawMetadata("dateTimeOriginal") or p:getRawMetadata("captureTime") or p:getRawMetadata("dateTime")
    local hit = t and keys[b .. "|" .. LrDate.timeToUserFormat(t, "%Y-%m-%d")] or (not t and names[b] == 1)
    if hit then
      list[#list + 1] = p
    elseif #miss < 8 then
      miss[#miss + 1] = tostring(p:getFormattedMetadata("fileName")) .. "@" .. (t and LrDate.timeToUserFormat(t, "%Y-%m-%dT%H:%M:%S") or "日時なし")
    end
  end
  if #miss > 0 then log("処理済みと照合できなかった写真（一部）: " .. table.concat(miss, ", ")) end
  if #list == 0 then return 0 end
  catalog:withWriteAccessDo("処理済みを移動", function()
    local dest = catalog:createCollection(M.DONE_COLLECTION, nil, true)
    dest:addPhotos(list)
    col:removePhotos(list)
  end, { timeout = 120 })
  log("処理済み " .. #list .. "枚を「" .. M.DONE_COLLECTION .. "」へ移動")
  return #list
end

-- 本体。targets を省くと「インスタ投稿」の未レタッチ写真。progress は LrProgressScope（無くてもよい）
function M.run(targets, progress)
  local catalog = LrApplication.activeCatalog()
  if not targets then
    local col = M.findCollection(catalog)
    if not col then return 0, "コレクション「" .. M.COLLECTION .. "」が見つかりません" end
    targets = {}
    for _, p in ipairs(col:getPhotos()) do
      if M.isUnedited(p) then targets[#targets + 1] = p end
    end
  end
  if #targets == 0 then return 0, "レタッチする写真はありません" end
  log("AIレタッチ開始 " .. #targets .. "枚")
  local function step(text) if progress then progress:setCaption(text) end end

  -- ① 見て決める
  step("① AIが " .. #targets .. "枚を見てレタッチを決めています…")
  local dir = M.WORK .. "\\in"
  render(targets, dir, false)
  local res, err = askAI("plan", dir)
  if not res then log("⚠ " .. err) return 0, err end

  -- ② 当てる
  local pp, ps = findPreset(M.PRESET_PORTRAIT), findPreset(M.PRESET_SNAP)
  local done, np = {}, 0
  catalog:withWriteAccessDo("NAOE AIレタッチ", function()
    for _, p in ipairs(targets) do
      local r = res[tostring(p.localIdentifier)]
      if r then
        local preset = r.portrait and pp or ps
        if preset then p:applyDevelopPreset(preset, _PLUGIN) end
        applyKV(p, r.kv)
        done[#done + 1] = p
        if r.portrait then np = np + 1 end
      end
    end
  end, { timeout = 300 })

  -- ③ 仕上げチェック
  for i = 1, M.REVIEWS do
    if #done == 0 then break end
    step("③ 仕上がりをチェック中（" .. i .. "/" .. M.REVIEWS .. "）…")
    local rdir = M.WORK .. "\\review"
    render(done, rdir, true)
    local fix = askAI("review", rdir)
    if not fix then break end
    local changed = 0
    catalog:withWriteAccessDo("NAOE AIレタッチ（仕上げ）", function()
      for _, p in ipairs(done) do
        local r = fix[tostring(p.localIdentifier)]
        if r and next(r.kv) then
          applyKV(p, r.kv)
          changed = changed + 1
        end
      end
    end, { timeout = 300 })
    log("仕上げ " .. i .. "回目: " .. changed .. "枚を修正")
    if changed == 0 then break end
  end

  local msg = #done .. "枚をAIレタッチしました（ポートレート " .. np .. "枚 / スナップ " .. (#done - np) .. "枚）"
  log(msg)
  return #done, msg
end

return M
