-- 共通処理：コレクション探し・未レタッチの判定・AI判定（PCの node + claude）・レタッチの適用
local LrApplication = import "LrApplication"
local LrTasks = import "LrTasks"
local LrFileUtils = import "LrFileUtils"
local LrPathUtils = import "LrPathUtils"
local LrDate = import "LrDate"

local M = {}
M.COLLECTION = "インスタ投稿"
M.ROOT = "C:\\Users\\tanos\\sites\\insta-autopost"
M.WORK = M.ROOT .. "\\.work\\classic"
M.NODE = "C:\\Program Files\\nodejs\\node.exe"
M.PRESET_PORTRAIT = "NAOE ポートレート"
M.PRESET_SNAP = "NAOE スナップ"

-- プリセットが見つからない時の予備（make-presets.js の集計結果と同じ値）
M.STYLE = {
  portrait = {
    Contrast2012 = 0, Highlights2012 = -100, Shadows2012 = 25, Whites2012 = 0, Blacks2012 = -20,
    Texture = 0, Clarity2012 = 0, Dehaze = 0, Vibrance = 0, Saturation = 0,
    SplitToningShadowHue = 200, SplitToningShadowSaturation = 17,
    SplitToningHighlightHue = 33, SplitToningHighlightSaturation = 14, SplitToningBalance = 0, ColorGradeBlending = 50,
  },
  snap = {
    Contrast2012 = 20, Highlights2012 = -20, Shadows2012 = 10, Whites2012 = 0, Blacks2012 = -20,
    Texture = 25, Clarity2012 = 25, Dehaze = 0, Vibrance = 0, Saturation = 0,
    SplitToningShadowHue = 214, SplitToningShadowSaturation = 23,
    SplitToningHighlightHue = 23, SplitToningHighlightSaturation = 23, SplitToningBalance = 0, ColorGradeBlending = 50,
  },
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

local function findPreset(name)
  for _, folder in ipairs(LrApplication.developPresetFolders()) do
    for _, p in ipairs(folder:getDevelopPresets()) do
      if p:getName() == name then return p end
    end
  end
end

-- 写真の縮小JPEGを書き出す（AIに見せる用）
local function exportThumbs(photos, dir)
  LrFileUtils.createAllDirectories(dir)
  for f in LrFileUtils.files(dir) do LrFileUtils.delete(f) end
  local pending = 0
  local holders = {}
  for _, p in ipairs(photos) do
    local id = tostring(p.localIdentifier)
    local path = LrPathUtils.child(dir, id .. ".jpg")
    pending = pending + 1
    local done = false
    holders[#holders + 1] = p:requestJpegThumbnail(1024, 1024, function(jpeg)
      if jpeg and #jpeg > 2000 then
        local f = io.open(path, "wb")
        if f then f:write(jpeg) f:close() end
        if not done then done = true pending = pending - 1 end
      end
    end)
  end
  -- 全部そろうまで最大60秒待つ
  for _ = 1, 120 do
    if pending <= 0 then break end
    LrTasks.sleep(0.5)
  end
  holders = nil
end

-- AI判定：classic-classify.js が result.tsv（ID・ポートレート・露光量の補正）を書く
local function classify(dir)
  local cmd = '""' .. M.NODE .. '" "' .. M.ROOT .. '\\classic-classify.js" "' .. dir .. '""'
  local code = LrTasks.execute(cmd)
  local out = {}
  local f = io.open(dir .. "\\result.tsv", "r")
  if not f then return nil, "AIの判定結果がありません（終了コード " .. tostring(code) .. "）" end
  for line in f:lines() do
    local id, portrait, ev = line:match("^(%S+)\t(%d)\t([%-%d%.]+)")
    if id then out[id] = { portrait = portrait == "1", ev = tonumber(ev) or 0 } end
  end
  f:close()
  return out
end

-- 本体。quiet=true なら確認ダイアログを出さない（自動実行用）。戻り値: 処理した枚数, メッセージ
function M.run(quiet)
  local catalog = LrApplication.activeCatalog()
  local col = M.findCollection(catalog)
  if not col then return 0, "コレクション「" .. M.COLLECTION .. "」が見つかりません" end
  local targets = {}
  for _, p in ipairs(col:getPhotos()) do
    if M.isUnedited(p) then targets[#targets + 1] = p end
  end
  if #targets == 0 then return 0, "未レタッチの写真はありません" end
  log("未レタッチ " .. #targets .. "枚")

  local dir = M.WORK .. "\\in"
  exportThumbs(targets, dir)
  local res, err = classify(dir)
  if not res then
    log("⚠ " .. err)
    return 0, err
  end

  local pp, ps = findPreset(M.PRESET_PORTRAIT), findPreset(M.PRESET_SNAP)
  local n, np = 0, 0
  catalog:withWriteAccessDo("NAOE 自動レタッチ", function()
    for _, p in ipairs(targets) do
      local r = res[tostring(p.localIdentifier)]
      if r then
        local base = tonumber(p:getDevelopSettings().Exposure2012) or 0
        local preset = r.portrait and pp or ps
        if preset then
          p:applyDevelopPreset(preset, _PLUGIN)
        else
          p:applyDevelopSettings(r.portrait and M.STYLE.portrait or M.STYLE.snap)
        end
        -- 露光量は写真ごとにAIの見立てで（今の明るさからの補正）
        local ev = math.max(-1.5, math.min(2.5, base + r.ev))
        p:applyDevelopSettings({ Exposure2012 = math.floor(ev * 100 + 0.5) / 100 })
        n = n + 1
        if r.portrait then np = np + 1 end
      end
    end
  end, { timeout = 120 })
  local msg = n .. "枚をレタッチしました（ポートレート " .. np .. "枚 / スナップ " .. (n - np) .. "枚）"
  if not pp or not ps then msg = msg .. "\n※プリセットが見つからなかったため、肌のマスクなしの設定で当てました" end
  log(msg)
  return n, msg
end

return M
