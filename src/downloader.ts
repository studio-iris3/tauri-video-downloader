export function friendlyError(error: unknown) {
  const text = String(error);

  if (
    text.includes("Sign in to confirm") ||
    text.includes("not a bot") ||
    text.includes("--cookies-from-browser")
  ) {
    return "YouTubeのbot判定が出ています。Cookie BrowserをChrome/Safari/Firefoxなどログイン済みブラウザに変更して再試行してください。";
  }

  return text;
}