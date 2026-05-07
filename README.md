# Studio Iris Video Downloader

元のUI・仕様を保った Tauri v2 + React + TypeScript の動画ダウンローダーです。

## ローカル確認

```bash
npm install
npm run start
```

ブラウザUIだけ確認できます。Tauri機能まで確認する場合:

```bash
npm run tauri dev
```

## ビルド

```bash
npm run tauri build
```

## GitHub Actions

`.github/workflows/build.yml` に Mac / Windows / Linux 用ビルド設定を入れています。
main に push すると自動ビルドします。
