-- NAOE 自動レタッチ（Lightroom Classic プラグイン）
-- コレクション「インスタ投稿」の未レタッチ写真に、普段のレタッチ（ポートレート／スナップ）を自動で当てる。
return {
  LrSdkVersion = 14.0,
  LrSdkMinimumVersion = 10.0,
  LrToolkitIdentifier = "com.naoeworks.autoretouch",
  LrPluginName = "NAOE 自動レタッチ",
  LrInitPlugin = "Init.lua",
  LrLibraryMenuItems = {
    { title = "自動レタッチのオン／オフ", file = "ToggleAuto.lua" },
    { title = "取り込んだRAWを今すぐAIレタッチ", file = "RunImported.lua" },
    { title = "インスタ投稿を自動レタッチ", file = "RunRetouch.lua" },
    { title = "選択した写真をAIレタッチ（やり直し）", file = "RetouchSelected.lua" },
    { title = "処理済みの写真を移動して軽くする", file = "MoveProcessed.lua" },
    { title = "インスタ投稿でノイズ除去がまだの写真を選択", file = "SelectDenoise.lua" },
    { title = "クラウド整理の準備（投稿予定以外を外す）", file = "CloudCleanup.lua" },
    { title = "選択中の写真の現像設定を書き出す（調査用）", file = "DumpSettings.lua" },
  },
  LrExportMenuItems = {
    { title = "インスタ投稿を自動レタッチ", file = "RunRetouch.lua" },
  },
  VERSION = { major = 1, minor = 0, revision = 0 },
}
