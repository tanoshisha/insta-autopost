-- 調査用：選択中の写真の現像設定（キーと値）をテキストに書き出す
local LrApplication = import "LrApplication"
local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local Common = require "Common"

LrTasks.startAsyncTask(function()
  local photos = LrApplication.activeCatalog():getTargetPhotos()
  local out = Common.WORK .. "\\dump.txt"
  local f = io.open(out, "w")
  if not f then
    return LrDialogs.message("書き出せませんでした", out)
  end
  for _, p in ipairs(photos) do
    f:write("### ", tostring(p:getFormattedMetadata("fileName")), "\n")
    local s = p:getDevelopSettings()
    local keys = {}
    for k in pairs(s) do keys[#keys + 1] = k end
    table.sort(keys)
    for _, k in ipairs(keys) do
      local v = s[k]
      if type(v) == "table" then
        f:write(k, " = <table ", tostring(#v), ">\n")
      else
        f:write(k, " = ", tostring(v), "\n")
      end
    end
  end
  f:close()
  LrDialogs.message("現像設定を書き出しました", out)
end)
