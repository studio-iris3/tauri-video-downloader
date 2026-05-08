# Studio Iris Video Downloader

Tauri v2 + React + TypeScript + Vite で作成した、Mac / Windows 対応の動画ダウンローダーGUIアプリです。

## 主な機能
- QuickTime / iPhone 向け H.264 MP4 優先
- YouTube bot 判定対策
- Cookie Browser 対応改善
- 軽量化済み
- ログ表示ON/OFF
- GitHub Releases 配布
- Mac / Windows 両対応
- 動画情報取得
- MP4ダウンロード
- 音声/映像の自動結合
- ffmpeg merge対応
- yt-dlp同梱
- ffmpeg / ffprobe同梱
- 保存先未指定時はDownloadsへ保存
- プログレスバー
- ログ表示
- ダウンロードキュー
- 再試行 / 停止
- Cookie Browser対応

## ダウンロード

GitHub Releases から最新版をダウンロードしてください。

## Macでの初回起動について

現在の配布版はAppleのnotarization未対応です。

そのため初回起動時に、macOSのセキュリティ警告が表示される場合があります。

開けない場合は以下を試してください。

1. アプリを一度起動する
2. 警告が出たら閉じる
3. システム設定を開く
4. プライバシーとセキュリティを開く
5. 下部に表示される許可ボタンからアプリを許可する

将来的にはDeveloper ID署名とnotarizationに対応予定です。

## Windowsでの初回起動について

現在の配布版はコード署名証明書による署名が未対応です。

そのため初回起動時に Windows Defender SmartScreen の警告が表示される場合があります。

表示された場合は、

1. 詳細情報
2. 実行

を選択してください。

将来的にはコード署名証明書による署名対応を検討しています。

## Cookie Browserについて

YouTubeなどでログイン状態が必要な動画では、Cookie Browserを指定してください。

例:

- chrome
- edge
- firefox
- safari

通常の動画では指定しなくても動作します。

## 保存先

保存先を指定しない場合、自動的にOS標準のDownloadsフォルダへ保存されます。

## 注意事項

このアプリは yt-dlp と ffmpeg を内部で使用しています。

利用する動画サイトの規約、著作権、各国の法律を守って使用してください。

## 今後の予定

- アプリ軽量化
- README改善
- ダウンロード履歴
- 同時ダウンロード数制御
- Auto Updater
- Mac notarization
- Windows code signing

## v1.2.0 更新内容

- アプリ軽量化
- backend log emit 最適化
- progress update 最適化
- YouTube bot 判定対策
- Cookie Browser ガイド改善
- H.264 MP4 優先化
- QuickTime 互換性向上
- ログ表示ON/OFF
- GitHub Actions build 改善

## 既知の問題

- YouTube側仕様変更により Cookie Browser が必要になる場合があります
- 一部動画では YouTube bot 判定が発生する場合があります
- 初回起動時に macOS / Windows のセキュリティ警告が表示される場合があります