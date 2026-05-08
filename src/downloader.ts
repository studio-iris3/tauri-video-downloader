export function friendlyError(error: unknown) {
  const text = String(error);
  const lower = text.toLowerCase();

  // Cookie取得失敗
  if (
    lower.includes("could not copy chrome cookie database") ||
    lower.includes("chrome cookie database") ||
    lower.includes("cookies-from-browser")
  ) {
    return [
      "Cookie Browser の取得に失敗しました。",
      "",
      "以下を試してください。",
      "・Cookie Browser を none に変更する",
      "・Chrome を完全終了して再試行する",
      "・Safari / Firefox / Brave を試す",
      "",
      "Chrome起動中は Cookie を取得できない場合があります。",
    ].join("\n");
  }

  // YouTube bot判定
  if (
    lower.includes("sign in to confirm") ||
    lower.includes("not a bot")
  ) {
    return [
      "YouTube 側で bot 判定が発生しています。",
      "",
      "以下を試してください。",
      "・Cookie Browser を Chrome/Safari/Firefox に変更",
      "・少し時間を置いて再試行",
      "・別動画で試す",
    ].join("\n");
  }

  // 非公開動画
  if (
    lower.includes("private video") ||
    lower.includes("this video is private")
  ) {
    return "この動画は非公開、またはログインが必要です。";
  }

  // 動画利用不可
  if (
    lower.includes("video unavailable") ||
    lower.includes("this video is unavailable")
  ) {
    return "この動画は利用できません。削除・地域制限などの可能性があります。";
  }

  // フォーマットなし
  if (
    lower.includes("requested format is not available") ||
    lower.includes("format is not available")
  ) {
    return "指定した画質または形式が利用できません。別の画質を試してください。";
  }

  // ffmpegエラー
  if (
    lower.includes("ffmpeg") &&
    (lower.includes("not found") || lower.includes("no such file"))
  ) {
    return "FFmpeg が見つかりません。アプリの同梱ファイルを確認してください。";
  }

  // yt-dlpエラー
  if (
    lower.includes("yt-dlp") &&
    (lower.includes("not found") || lower.includes("no such file"))
  ) {
    return "yt-dlp が見つかりません。アプリの同梱ファイルを確認してください。";
  }

  // 汎用exit code
  if (lower.includes("exit code: 1")) {
    return "ダウンロードに失敗しました。Cookie Browser や画質設定を変更して再試行してください。";
  }

  return text;
}