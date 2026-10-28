-- 調査用：選択中の写真の現像設定（キーと値）をテキストに書き出す。入れ子の表も中身まで（ノイズ除去などは FilterList の中）
local LrApplication = import "LrApplication"
local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local Common = require "Common"

local NL = "\n"

local function dump(f, k, v, indent, depth)
  if type(v) ~= "table" then
    f:write(indent, tostring(k), " = ", tostring(v), NL)
    return
  end
  if depth > 8 then
    f:write(indent, tostring(k), " = {...}", NL)
    return
  end
  f:write(indent, tostring(k), " = {", NL)
  local keys = {}
  for kk in pairs(v) do keys[#keys + 1] = kk end
  table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
  for _, kk in ipairs(keys) do dump(f, kk, v[kk], indent .. "  ", depth + 1) end
  f:write(indent, "}", NL)
end

LrTasks.startAsyncTask(function()
  local photos = LrApplication.activeCatalog():getTargetPhotos()
  local out = Common.WORK .. "\\dump.txt"
  local f = io.open(out, "w")
  if not f then
    return LrDialogs.message("書き出せませんでした", out)
  end
  for _, p in ipairs(photos) do
    f:write("### ", tostring(p:getFormattedMetadata("fileName")), NL)
    local s = p:getDevelopSettings()
    local keys = {}
    for k in pairs(s) do keys[#keys + 1] = k end
    table.sort(keys)
    for _, k in ipairs(keys) do dump(f, k, s[k], "", 0) end
  end
  f:close()
  LrDialogs.message("現像設定を書き出しました", out)
end)
