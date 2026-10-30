-- リールの回ごとのコレクション（コレクションセット「リール」の中）
--   一覧は PC の reel-pc.js が classic-reels.tsv に書く（コレクション名 \t 写真のUUIDをカンマ区切り）
--   コレクションの「Lightroom と同期」をオンにすると、iPhone の Lightroom にアルバムとして出る（オンは手で1回）
local LrApplication = import "LrApplication"
local Common = require "Common"

local M = {}
M.SET = "リール"

function M.sync()
  local f = io.open(Common.ROOT .. "\\classic-reels.tsv", "r")
  if not f then return 0 end
  local rows = {}
  for line in f:lines() do
    local name, list = line:match("^([^\t]+)\t(.*)$")
    if name then
      local u = {}
      for id in list:gmatch("[^,]+") do u[#u + 1] = id end
      rows[#rows + 1] = { name = name, uuids = u }
    end
  end
  f:close()
  if #rows == 0 then return 0 end
  local catalog = LrApplication.activeCatalog()
  -- 写真を探す（書き込みの外で）
  for _, r in ipairs(rows) do
    r.photos = {}
    for _, u in ipairs(r.uuids) do
      local p = catalog:findPhotoByUuid(u)
      if p then r.photos[#r.photos + 1] = p end
    end
  end
  local changed = 0
  catalog:withWriteAccessDo("リールのコレクション", function()
    local set = catalog:createCollectionSet(M.SET, nil, true)
    for _, r in ipairs(rows) do
      local col = catalog:createCollection(r.name, set, true)
      local want, have = {}, {}
      for _, p in ipairs(r.photos) do want[p.localIdentifier] = p end
      local remove = {}
      for _, p in ipairs(col:getPhotos()) do
        have[p.localIdentifier] = true
        if not want[p.localIdentifier] then remove[#remove + 1] = p end
      end
      local add = {}
      for id, p in pairs(want) do
        if not have[id] then add[#add + 1] = p end
      end
      if #add > 0 then col:addPhotos(add) end
      if #remove > 0 then col:removePhotos(remove) end
      changed = changed + #add + #remove
    end
  end, { timeout = 60 })
  if changed > 0 then Common.log("リールのコレクションを更新: " .. changed .. "枚") end
  return changed
end

return M
