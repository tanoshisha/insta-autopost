-- メニュー「クラウド整理の準備」
--  ① 「Lightroom から」のアルバム（クラウドのアルバム）を、Classicだけのコレクションに複製して守る
--     （クラウドから外すと「Lightroom から」の中からも消えるため）
--  ② クラウドから外す写真に、目印のキーワード「_クラウドから外す」を付ける（一覧は PC の cloud-cleanup.js が作る）
--  このあとは手で: 「すべての同期写真」→ キーワードで絞り込み → 全選択 → 「すべての同期写真から削除」
local LrApplication = import "LrApplication"
local LrTasks = import "LrTasks"
local LrDialogs = import "LrDialogs"
local LrProgressScope = import "LrProgressScope"
local Common = require "Common"

local KEYWORD = "_クラウドから外す"
local SAVE_SET = "クラウドのアルバム（Classicに保存）"

LrTasks.startAsyncTask(function()
  local catalog = LrApplication.activeCatalog()
  local f = io.open(Common.ROOT .. "\\classic-cloud-remove.tsv", "r")
  if not f then return LrDialogs.message("一覧がありません", "先にPCで cloud-cleanup.js を実行してください") end
  local uuids = {}
  for line in f:lines() do
    local u = line:match("^(%S+)")
    if u then uuids[#uuids + 1] = u end
  end
  f:close()

  local go = LrDialogs.confirm(
    "クラウド整理の準備",
    #uuids .. "枚に目印「" .. KEYWORD .. "」を付けます。\n先に「Lightroom から」のアルバムを「" .. SAVE_SET .. "」へ複製して守ります。\n（写真の削除や移動はしません）",
    "準備する", "やめる"
  )
  if go ~= "ok" then return end
  local progress = LrProgressScope({ title = "クラウド整理の準備" })

  -- ① アルバムを複製
  local fromLr
  for _, s in ipairs(catalog:getChildCollectionSets()) do
    if s:getName():find("Lightroom") then fromLr = s end
  end
  local copied = 0
  if fromLr then
    catalog:withWriteAccessDo("アルバムを複製", function()
      local set = catalog:createCollectionSet(SAVE_SET, nil, true)
      for _, c in ipairs(fromLr:getChildCollections()) do
        local photos = c:getPhotos()
        if #photos > 0 and c:getName() ~= Common.COLLECTION then
          local dest = catalog:createCollection(c:getName(), set, true)
          dest:addPhotos(photos)
          copied = copied + 1
        end
      end
    end, { timeout = 300 })
  end
  progress:setPortionComplete(1, 3)

  -- ② 目印のキーワード
  local photos = {}
  for _, u in ipairs(uuids) do
    local p = catalog:findPhotoByUuid(u)
    if p then photos[#photos + 1] = p end
  end
  catalog:withWriteAccessDo("クラウドから外す目印", function()
    local kw = catalog:createKeyword(KEYWORD, {}, false, nil, true)
    for i, p in ipairs(photos) do
      p:addKeyword(kw)
      if i % 200 == 0 then progress:setPortionComplete(1 + i / #photos, 3) end
    end
  end, { timeout = 600 })
  progress:done()
  Common.log("クラウド整理の準備: アルバム複製 " .. copied .. " / 目印 " .. #photos .. "枚")

  LrDialogs.message(
    "準備ができました",
    "・アルバム " .. copied .. "個を「" .. SAVE_SET .. "」に複製しました\n・" .. #photos .. "枚に目印「" .. KEYWORD .. "」を付けました\n\n" ..
      "仕上げ（手で1回だけ）:\n1. 左の「カタログ」→「すべての同期写真」を開く\n2. 上の「ライブラリフィルター」→「テキスト」→「キーワード」「含む」に " .. KEYWORD .. "\n3. Ctrl+A で全選択 → Deleteキー →「すべての同期写真から削除」\n\nClassicの写真はそのまま残り、クラウドからだけ外れます。"
  )
end)
