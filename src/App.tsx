import React, { memo, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { version } from "../package.json";
import { friendlyError } from "./downloader";
import {
  clearSavedHistory,
  loadHistory,
  saveHistory,
  type DownloadHistory,
} from "./history";

type FormatType = "mp4" | "mp3";
type ItemStatus =
  | "待機中"
  | "情報取得中"
  | "ダウンロード中"
  | "完了"
  | "エラー"
  | "キャンセル済み";

type VideoInfo = {
  title: string;
  thumbnail: string;
};

type DownloadProgressPayload = {
  job_id: string;
  percent: number;
};

type ToolVersions = {
  app: string;
  yt_dlp: string;
  ffmpeg: string;
};

type DownloadItem = {
  id: string;
  url: string;
  title: string;
  thumbnail: string;
  formatType: FormatType;
  mp4Quality: string;
  mp3Quality: string;
  progress: number;
  status: ItemStatus;
  message: string;
};

const mp4Qualities = [
  { label: "最高画質", value: "best" },
  { label: "1080p", value: "1080" },
  { label: "720p", value: "720" },
  { label: "480p", value: "480" },
];

const mp3Qualities = [
  { label: "320kbps", value: "320K" },
  { label: "192kbps", value: "192K" },
  { label: "128kbps", value: "128K" },
];

const cookieBrowsers = [
  { label: "Cookieなし", value: "none" },
  { label: "Chrome", value: "chrome" },
  { label: "Safari", value: "safari" },
  { label: "Firefox", value: "firefox" },
  { label: "Brave", value: "brave" },
  { label: "Edge", value: "edge" },
];

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DownloadCard = memo(function DownloadCard({
  item,
  updateItem,
  getInfoForItem,
  retryItem,
  cancelItem,
  removeItem,
}: {
  item: DownloadItem;
  updateItem: (id: string, patch: Partial<DownloadItem>) => void;
  getInfoForItem: (item: DownloadItem) => void;
  retryItem: (id: string) => void;
  cancelItem: (id: string) => void;
  removeItem: (id: string) => void;
}) {
  return (
    <div style={cardStyle}>
      <div style={thumbnailBoxStyle}>
        {item.thumbnail ? (
          <img
            loading="lazy"
            src={item.thumbnail}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : (
          "No Image"
        )}
      </div>

      <div style={{ flex: 1 }}>
        <div style={cardHeaderStyle}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>
            {item.title || "タイトル未取得"}
          </div>
          <span style={statusBadgeStyle}>{item.status}</span>
        </div>

        <div style={urlTextStyle}>{item.url}</div>

        <div style={cardButtonRowStyle}>
          <select
            value={item.formatType}
            onChange={(event) =>
              updateItem(item.id, {
                formatType: event.target.value as FormatType,
              })
            }
            style={selectStyle}
          >
            <option value="mp4">MP4</option>
            <option value="mp3">MP3</option>
          </select>

          {item.formatType === "mp4" && (
            <select
              value={item.mp4Quality}
              onChange={(event) =>
                updateItem(item.id, {
                  mp4Quality: event.target.value,
                })
              }
              style={selectStyle}
            >
              {mp4Qualities.map((quality) => (
                <option key={quality.value} value={quality.value}>
                  {quality.label}
                </option>
              ))}
            </select>
          )}

          {item.formatType === "mp3" && (
            <select
              value={item.mp3Quality}
              onChange={(event) =>
                updateItem(item.id, {
                  mp3Quality: event.target.value,
                })
              }
              style={selectStyle}
            >
              {mp3Qualities.map((quality) => (
                <option key={quality.value} value={quality.value}>
                  {quality.label}
                </option>
              ))}
            </select>
          )}

          <button onClick={() => getInfoForItem(item)} style={buttonStyle("orange")}>
            情報取得
          </button>
          <button onClick={() => retryItem(item.id)} style={buttonStyle("blue")}>
            再試行
          </button>
          <button onClick={() => cancelItem(item.id)} style={buttonStyle("red")}>
            停止
          </button>
          <button onClick={() => removeItem(item.id)} style={buttonStyle("gray")}>
            削除
          </button>
        </div>

        <div style={progressTrackStyle}>
          <div
            style={{
              ...progressBarStyle,
              width: `${item.progress}%`,
            }}
          />
        </div>

        <div style={progressTextStyle}>{Math.round(item.progress)}%</div>

        {item.message && <div style={itemMessageStyle}>{item.message}</div>}
      </div>
    </div>
  );
});

function App() {
  const [urlText, setUrlText] = useState("");
  const [savePath, setSavePath] = useState("");
  const [items, setItems] = useState<DownloadItem[]>([]);
  const itemsRef = useRef<DownloadItem[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const showLogsRef = useRef(false);
  const progressRef = useRef<Record<string, number>>({});
  const [message, setMessage] = useState("");
  const [isDownloading, setIsDownloading] = useState(false);
  const cancelledIdsRef = useRef<Set<string>>(new Set());

  const [bulkFormatType, setBulkFormatType] = useState<FormatType>("mp4");
  const [bulkMp4Quality, setBulkMp4Quality] = useState("1080");
  const [bulkMp3Quality, setBulkMp3Quality] = useState("192K");
  const [cookieBrowser, setCookieBrowser] = useState("none");
  const [concurrentCount, setConcurrentCount] = useState(1);
  const [showHelp, setShowHelp] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [history, setHistory] = useState<DownloadHistory[]>([]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    showLogsRef.current = showLogs;
  }, [showLogs]);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  useEffect(() => {
    invoke<string>("get_default_download_dir")
      .then((dir) => {
        setSavePath((current) => (current.trim() ? current : dir));
      })
      .catch(() => {
        if (showLogsRef.current) {
          setLogs((prev) => [
            ...prev.slice(-30),
            "デフォルトのダウンロードフォルダを取得できませんでした",
          ]);
        }
      });

    let lastProgressUpdate = 0;

    const unlistenProgress = listen<DownloadProgressPayload>(
      "download-progress",
      (event) => {
        const now = Date.now();
        if (now - lastProgressUpdate < 1000) return;
        lastProgressUpdate = now;

        const { job_id, percent } = event.payload;
        const roundedPercent = Math.round(Math.min(100, Math.max(0, percent)));
        const previousPercent = progressRef.current[job_id] ?? 0;

        if (
          Math.abs(roundedPercent - previousPercent) < 1 &&
          roundedPercent !== 100
        ) {
          return;
        }

        progressRef.current[job_id] = roundedPercent;

        setItems((prev) =>
          prev.map((item) =>
            item.id === job_id && Math.round(item.progress) !== roundedPercent
              ? { ...item, progress: roundedPercent }
              : item,
          ),
        );
      },
    );

    const unlistenLog = listen<string>("download-log", (event) => {
      if (!showLogsRef.current) return;

      setLogs((prev) => {
        if (prev[prev.length - 1] === event.payload) return prev;
        return [...prev.slice(-30), event.payload];
      });
    });

    return () => {
      unlistenProgress.then((unlisten) => unlisten());
      unlistenLog.then((unlisten) => unlisten());
    };
  }, []);

  async function openLatestRelease() {
    const url =
      "https://github.com/studio-iris3/tauri-video-downloader/releases/latest";

    try {
      await openUrl(url);
      setMessage(`最新版確認ページを開きました。現在のバージョンは v${version} です。`);
    } catch (error) {
      console.error(error);
      setMessage("Releaseページを開けませんでした。ブラウザ設定または権限設定を確認してください。");
    }
  }

  async function showToolVersions() {
    try {
      const versions = await invoke<ToolVersions>("get_tool_versions");

      setMessage(
        [
          `アプリ: ${versions.app}`,
          `yt-dlp: ${versions.yt_dlp}`,
          `ffmpeg: ${versions.ffmpeg}`,
        ].join("\n"),
      );
    } catch (error) {
      setMessage(`バージョン情報を取得できませんでした: ${String(error)}`);
    }
  }

  async function chooseFolder() {
    const input = window.prompt("保存先フォルダのフルパスを入力してください", savePath);
    if (input && input.trim()) {
      setSavePath(input.trim());
      setMessage("保存先を変更しました");
    }
  }

  function addUrls() {
    const urls = urlText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length && /^https?:\/\//i.test(line));

          const existingUrls = new Set(
      itemsRef.current.map((item) => item.url),
    );

    const uniqueUrls = urls.filter(
      (url) => !existingUrls.has(url),
    );

    if (!uniqueUrls.length) {
      setMessage("すべて既に追加済みのURLです");
      return;
    }

    if (!urls.length) {
      setMessage("有効なURLを入力してください");
      return;
    }

    const newItems: DownloadItem[] = uniqueUrls.map((url) => ({
      id: createId(),
      url,
      title: "",
      thumbnail: "",
      formatType: bulkFormatType,
      mp4Quality: bulkMp4Quality,
      mp3Quality: bulkMp3Quality,
      progress: 0,
      status: "待機中",
      message: "",
    }));

    setItems((prev) => [...prev, ...newItems]);
    setUrlText("");
    setMessage(
  `${newItems.length}件追加しました` +
    (urls.length !== uniqueUrls.length
      ? `（${urls.length - uniqueUrls.length}件は重複を除外）`
      : ""),
    );
  }
  async function pasteFromClipboard() {
    try {
      const text = await readText();

      if (!text) {
        alert("クリップボードが空です");
        return;
      }

      setUrlText((prev) => {
        if (!prev.trim()) {
          return text;
        }

        return `${prev}\n${text}`;
      });
    } catch (error) {
      console.error(error);
      alert("クリップボードの読み取りに失敗しました");
    }
  }

  function updateItem(id: string, patch: Partial<DownloadItem>) {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function clearItems() {
    if (isDownloading) return;
    cancelledIdsRef.current.clear();
    setItems([]);
    setLogs([]);
    setMessage("リストをクリアしました");
  }

  function removeItem(id: string) {
    if (isDownloading) return;
    cancelledIdsRef.current.delete(id);
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  function applyBulkSettings() {
    setItems((prev) =>
      prev.map((item) => ({
        ...item,
        formatType: bulkFormatType,
        mp4Quality: bulkMp4Quality,
        mp3Quality: bulkMp3Quality,
      })),
    );
    setMessage("一括設定を適用しました");
  }

  async function getInfoForItem(item: DownloadItem) {
    updateItem(item.id, { status: "情報取得中", message: "取得中..." });

    try {
      const res = await invoke<VideoInfo>("get_video_info", {
        url: item.url,
        cookieBrowser,
      });

      updateItem(item.id, {
        title: res.title,
        thumbnail: res.thumbnail,
        status: "待機中",
        message: "情報取得完了",
      });
    } catch (error) {
      updateItem(item.id, {
        status: "エラー",
        message: friendlyError(error),
      });
    }
  }

  async function getInfoAll() {
    if (!items.length) {
      setMessage("URLを追加してください");
      return;
    }

    setMessage("情報取得中... YouTube対策のため1件ずつ取得します");

    for (const item of itemsRef.current) {
      if (cancelledIdsRef.current.has(item.id)) continue;
      await getInfoForItem(item);
      await sleep(1500);
    }

    setMessage("情報取得完了");
  }

  function addHistory(title: string, url: string) {
    const next: DownloadHistory[] = [
      {
        title,
        url,
        date: new Date().toLocaleString(),
      },
      ...history,
    ].slice(0, 30);

    setHistory(next);
    saveHistory(next);
  }

  function clearHistory() {
    setHistory([]);
    clearSavedHistory();
    setMessage("ダウンロード履歴をクリアしました");
  }

  async function runSingleDownload(id: string) {
    if (cancelledIdsRef.current.has(id)) return;

    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item || item.status === "完了") return;

    updateItem(id, {
      status: "ダウンロード中",
      progress: 0,
      message: "ダウンロード中...",
    });

    try {
      const result = await invoke<string>("download_video", {
        jobId: item.id,
        url: item.url,
        savePath,
        formatType: item.formatType,
        mp4Quality: item.mp4Quality,
        mp3Quality: item.mp3Quality,
        cookieBrowser,
      });

      if (cancelledIdsRef.current.has(id)) {
        updateItem(id, {
          status: "キャンセル済み",
          progress: 0,
          message: "キャンセル",
        });
      } else {
        updateItem(id, {
          status: "完了",
          progress: 100,
          message: result,
        });

        addHistory(item.title || "タイトル未取得", item.url);
      }
    } catch (error) {
      if (cancelledIdsRef.current.has(id)) {
        updateItem(id, {
          status: "キャンセル済み",
          progress: 0,
          message: "キャンセル",
        });
      } else {
        updateItem(id, {
          status: "エラー",
          message: friendlyError(error),
        });
      }
    }
  }

  async function retryItem(id: string) {
    cancelledIdsRef.current.delete(id);
    updateItem(id, {
      status: "待機中",
      progress: 0,
      message: "再試行準備中...",
    });

    await sleep(1000);
    await runSingleDownload(id);
  }

  async function cancelItem(id: string) {
    cancelledIdsRef.current.add(id);

    try {
      await invoke<string>("cancel_download", { jobId: id });
    } catch {
      // ignore
    }

    updateItem(id, {
      status: "キャンセル済み",
      progress: 0,
      message: "キャンセル",
    });
  }

  async function downloadAll() {
    if (!items.length) {
      setMessage("URLを追加してください");
      return;
    }

    setIsDownloading(true);
    setLogs([]);
    setMessage(`同時DL ${concurrentCount}で開始 / 保存先: ${savePath || "Downloads"}`);

    const queue = itemsRef.current
      .filter((item) => item.status !== "完了")
      .filter((item) => !cancelledIdsRef.current.has(item.id))
      .map((item) => item.id);

    let cursor = 0;

    async function worker() {
      while (cursor < queue.length) {
        const id = queue[cursor];
        cursor += 1;
        await runSingleDownload(id);
        await sleep(1500);
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrentCount, queue.length) }, () => worker()));

    setIsDownloading(false);
    setMessage("ダウンロード処理完了");
  }

  return (
    <div style={appStyle}>
      <h1 style={titleStyle}>Studio Iris Video Downloader</h1>

      <div style={controlPanelStyle}>
        <select value={bulkFormatType} onChange={(event) => setBulkFormatType(event.target.value as FormatType)} style={selectStyle}>
          <option value="mp4">MP4</option>
          <option value="mp3">MP3</option>
        </select>

        {bulkFormatType === "mp4" && (
          <select value={bulkMp4Quality} onChange={(event) => setBulkMp4Quality(event.target.value)} style={selectStyle}>
            {mp4Qualities.map((quality) => (
              <option key={quality.value} value={quality.value}>
                {quality.label}
              </option>
            ))}
          </select>
        )}

        {bulkFormatType === "mp3" && (
          <select value={bulkMp3Quality} onChange={(event) => setBulkMp3Quality(event.target.value)} style={selectStyle}>
            {mp3Qualities.map((quality) => (
              <option key={quality.value} value={quality.value}>
                {quality.label}
              </option>
            ))}
          </select>
        )}

        <select value={cookieBrowser} onChange={(event) => setCookieBrowser(event.target.value)} style={selectStyle}>
          {cookieBrowsers.map((browser) => (
            <option key={browser.value} value={browser.value}>
              {browser.label}
            </option>
          ))}
        </select>

        <div style={countBoxStyle}>
          <div style={countLabelStyle}>同時DL数</div>
          <input
            type="number"
            min={1}
            max={2}
            value={concurrentCount}
            onChange={(event) =>
              setConcurrentCount(Math.min(2, Math.max(1, Number(event.target.value))))
            }
            style={countInputStyle}
          />
        </div>

        <button onClick={applyBulkSettings} style={buttonStyle("blue")}>一括適用</button>
        <button onClick={getInfoAll} style={buttonStyle("orange")}>全URL情報取得</button>


        <button
          onClick={() => {
            setShowLogs((prev) => {
              const next = !prev;
              if (!next) setLogs([]);
              return next;
            });
          }}
          style={buttonStyle("gray")}
        >
          {showLogs ? "ログを隠す" : `ログ表示${logs.length ? ` (${logs.length})` : ""}`}
        </button>
      </div>

      <div style={savePanelStyle}>
        <span style={{ color: "#94a3b8" }}>保存先:</span>
        <span>{savePath || "未指定：自動でダウンロードフォルダに保存"}</span>
        <button onClick={chooseFolder} style={smallButtonStyle}>選択</button>
      </div>

            <div style={mainWorkAreaStyle}>
        <div style={leftWorkColumnStyle}>
          <textarea
            value={urlText}
            onChange={(event) => setUrlText(event.target.value)}
            placeholder="URLを1行ずつ"
            style={textareaStyle}
          />

          {message && <div style={messageStyle}>{message}</div>}

          <div style={{ display: "grid", gap: 12 }}>
            {items.map((item) => (
              <DownloadCard
                key={item.id}
                item={item}
                updateItem={updateItem}
                getInfoForItem={getInfoForItem}
                retryItem={retryItem}
                cancelItem={cancelItem}
                removeItem={removeItem}
              />
            ))}
          </div>
        </div>

        <div style={sideButtonColumnStyle}>
          <button onClick={pasteFromClipboard} style={buttonStyle("gray")}>
            貼り付け
          </button>

          <button onClick={addUrls} style={buttonStyle("blue")}>
            追加
          </button>

          <button onClick={clearItems} style={buttonStyle("red")}>
            クリア
          </button>

          <button onClick={downloadAll} style={buttonStyle("purple")}>
            {isDownloading ? "実行中..." : "ダウンロード"}
          </button>

          <button onClick={() => setShowHelp(true)} style={buttonStyle("gray")}>
            ？ヘルプ
          </button>

          <div
            style={{
              fontSize: 12,
              color: "rgba(255, 255, 255, 0.72)",
              textAlign: "center",
              lineHeight: 1.4,
            }}
          >
            現在のバージョン: v{version}
          </div>

          <button onClick={openLatestRelease} style={buttonStyle("gray")}>
            最新版を確認
          </button>

          <button onClick={showToolVersions} style={buttonStyle("gray")}>
            バージョン情報
          </button>

          <button onClick={() => setShowAbout(true)} style={buttonStyle("gray")}>
            About
          </button>
        </div>
      </div>

      {showLogs && logs.length > 0 && (
        <div style={logsStyle}>
          {logs.map((log, index) => (
            <div key={index}>{log}</div>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div style={historyPanelStyle}>
          <div style={historyHeaderStyle}>
            <h3 style={{ margin: 0 }}>ダウンロード履歴</h3>
            <button onClick={clearHistory} style={buttonStyle("red")}>履歴クリア</button>
          </div>

          <div style={{ display: "grid", gap: 8, maxHeight: 180, overflow: "auto" }}>
            {history.map((entry, index) => (
              <div key={index} style={historyItemStyle}>
                <div style={{ fontWeight: 800 }}>{entry.title}</div>
                <div style={{ color: "#94a3b8", wordBreak: "break-all" }}>{entry.url}</div>
                <div style={{ color: "#64748b", marginTop: 4 }}>{entry.date}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <footer style={footerStyle}>
        &copy; 2026 Studio Iris | v{version}
      </footer>

      {showHelp && (
        <div style={modalBackdropStyle}>
          <div style={modalStyle}>
            <h2 style={{ marginTop: 0 }}>使い方</h2>
            <ul style={{ paddingLeft: 20, lineHeight: 1.7 }}>
              <li>URLを1行ずつ入力して「追加」</li>
              <li>「貼り付け」でクリップボード内のURLを自動入力できます</li>
              <li>MP4/MP3、画質・音質は個別・一括設定可能</li>
              <li>Bot判定対策のため、情報取得とDLは控えめな同時実行にしています</li>
              <li>
                Cookie Browser はログイン済みブラウザを選んでください
                <ul style={{ marginTop: 8 }}>
                  <li>
                    <strong>none</strong> :
                    通常はこちらがおすすめです
                  </li>

                  <li>
                    <strong>chrome</strong> :
                    YouTubeログイン状態を利用します。
                    Chrome終了が必要な場合があります
                  </li>

                  <li>
                    <strong>safari</strong> :
                    Macで安定しやすいです
                  </li>

                  <li>
                    <strong>firefox</strong> :
                    bot対策回避に有効な場合があります
                  </li>

                  <li>
                    <strong>brave / edge</strong> :
                    Chrome系ブラウザとして利用可能です
                  </li>
                </ul>
              </li>
              <li>保存先未指定時はダウンロードフォルダに自動保存</li>
              <li>QuickTime互換のためH.264 MP4を優先します</li>
            </ul>
            <button onClick={() => setShowHelp(false)} style={buttonStyle("purple")}>閉じる</button>
          </div>
        </div>
      )}
      {showAbout && (
        <div style={modalBackdropStyle}>
          <div style={modalStyle}>
            <h2 style={{ marginTop: 0 }}>About</h2>

            <div style={{ lineHeight: 1.8, color: "#cbd5e1" }}>
              <div>
                <strong>Studio Iris Video Downloader</strong>
              </div>

              <div>Version: v{version}</div>
              <div>License: Private / Studio Iris</div>
              <div>© 2026 Studio Iris. All Rights Reserved.</div>

              <div>Build Target: macOS / Windows</div>
              <div>Framework: Tauri v2 Desktop App</div>

              <hr style={{ borderColor: "rgba(148,163,184,0.25)", margin: "16px 0" }} />

              <div style={{ fontWeight: 800, marginBottom: 6 }}>GitHub</div>
              <button
                onClick={() =>
                 openUrl("https://github.com/studio-iris3/tauri-video-downloader")
                }
               style={{
                border: "none",
                background: "transparent",
                color: "#60a5fa",
                cursor: "pointer",
                padding: 0,
                textAlign: "left",
                wordBreak: "break-all",
                fontSize: 14,
               }}
              >
                https://github.com/studio-iris3/tauri-video-downloader
              </button>

              <hr style={{ borderColor: "rgba(148,163,184,0.25)", margin: "16px 0" }} />

              <div style={{ fontWeight: 800, marginBottom: 6 }}>使用ライブラリ</div>
              <ul style={{ paddingLeft: 20, marginTop: 0 }}>
                <li>Tauri v2</li>
                <li>React</li>
                <li>TypeScript</li>
                <li>Vite</li>
                <li>Rust</li>
                <li>yt-dlp</li>
                <li>FFmpeg</li>
              </ul>
            </div>

            <button onClick={() => setShowAbout(false)} style={buttonStyle("purple")}>
              閉じる
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

const appStyle: React.CSSProperties = {
  padding: 20,
  fontFamily: "-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
  background: "radial-gradient(circle at top left,#13233f,#020617 45%,#020617)",
  minHeight: "100vh",
  color: "#e5e7eb",
};

const titleStyle: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 900,
  letterSpacing: "-0.04em",
  marginBottom: 18,
  textAlign: "left",
};

const controlPanelStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  marginBottom: 22,
  flexWrap: "wrap",
};

const selectStyle: React.CSSProperties = {
  height: 40,
  padding: "0 10px",
  borderRadius: 10,
  border: "1px solid rgba(148,163,184,0.3)",
  background: "linear-gradient(180deg,#334155,#1e293b)",
  color: "#ffffff",
  fontWeight: 800,
  fontSize: 14,
  outline: "none",
};

const countBoxStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 40,
  padding: "0 10px",
  borderRadius: 10,
  border: "1px solid rgba(148,163,184,0.3)",
  background: "linear-gradient(180deg,#334155,#1e293b)",
};

const countLabelStyle: React.CSSProperties = {
  color: "#e5e7eb",
  fontWeight: 800,
  fontSize: 13,
  whiteSpace: "nowrap",
  marginBottom: 0,
};

const countInputStyle: React.CSSProperties = {
  width: 48,
  height: 28,
  borderRadius: 8,
  border: "1px solid rgba(148,163,184,0.3)",
  background: "#0f172a",
  color: "#ffffff",
  fontSize: 15,
  fontWeight: 800,
  textAlign: "center",
};

const savePanelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  marginBottom: 16,
  padding: "18px 24px",
  borderRadius: 18,
  background: "rgba(30,41,59,0.82)",
  border: "1px solid rgba(148,163,184,0.25)",
  fontSize: 18,
};

const mainWorkAreaStyle: React.CSSProperties = {
  display: "flex",
  gap: 16,
  alignItems: "flex-start",
  marginBottom: 20,
};

const leftWorkColumnStyle: React.CSSProperties = {
  flex: 1,
  display: "grid",
  gap: 12,
};

const inputPanelStyle: React.CSSProperties = {
  display: "flex",
  gap: 16,
  marginBottom: 14,
  alignItems: "stretch",
};

const textareaStyle: React.CSSProperties = {
  flex: 1,
  height: 105,
  padding: 20,
  borderRadius: 18,
  background: "rgba(30,41,59,0.82)",
  border: "1px solid rgba(148,163,184,0.25)",
  color: "#e5e7eb",
  outline: "none",
  fontSize: 14,
  resize: "vertical",
};

const sideButtonColumnStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  width: 150,
  flexShrink: 0,
};

const buttonStyle = (
  color: "blue" | "green" | "red" | "purple" | "orange" | "gray",
): React.CSSProperties => {
  const map: Record<string, string> = {
    blue: "linear-gradient(135deg,#2563eb,#14b8a6)",
    green: "linear-gradient(135deg,#16a34a,#22c55e)",
    red: "linear-gradient(135deg,#dc2626,#f87171)",
    purple: "linear-gradient(135deg,#7c3aed,#2563eb)",
    orange: "linear-gradient(135deg,#f97316,#fbbf24)",
    gray: "linear-gradient(135deg,#64748b,#94a3b8)",
  };

  return {
    minHeight: 34,
    padding: "0 12px",
    fontSize: 12,
    whiteSpace: "nowrap",
    border: "none",
    background: map[color],
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    boxShadow: "0 10px 22px rgba(0,0,0,0.25)",
  };
};

const smallButtonStyle: React.CSSProperties = {
  marginLeft: "auto",
  padding: "10px 18px",
  borderRadius: 12,
  border: "1px solid rgba(148,163,184,0.3)",
  background: "linear-gradient(180deg,#475569,#334155)",
  color: "#fff",
  fontWeight: 800,
  cursor: "pointer",
};

const messageStyle: React.CSSProperties = {
  marginBottom: 12,
  padding: 14,
  borderRadius: 14,
  background: "rgba(15,23,42,0.9)",
  border: "1px solid rgba(148,163,184,0.25)",
  color: "#cbd5e1",
  whiteSpace: "pre-wrap",
};

const cardStyle: React.CSSProperties = {
  display: "flex",
  gap: 14,
  padding: 14,
  background: "rgba(30,41,59,0.9)",
  borderRadius: 18,
  border: "1px solid rgba(148,163,184,0.2)",
  boxShadow: "0 10px 26px rgba(0,0,0,0.32)",
};

const thumbnailBoxStyle: React.CSSProperties = {
  width: 150,
  height: 86,
  background: "#020617",
  borderRadius: 14,
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#64748b",
  fontSize: 12,
};

const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
};

const statusBadgeStyle: React.CSSProperties = {
  fontSize: 12,
  padding: "4px 10px",
  borderRadius: 999,
  background: "rgba(15,23,42,0.9)",
  color: "#cbd5e1",
};

const urlTextStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#94a3b8",
  wordBreak: "break-all",
  marginTop: 4,
};

const cardButtonRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  marginTop: 10,
  flexWrap: "wrap",
};

const progressTrackStyle: React.CSSProperties = {
  height: 8,
  background: "#334155",
  borderRadius: 999,
  marginTop: 10,
  overflow: "hidden",
};

const progressBarStyle: React.CSSProperties = {
  height: "100%",
  background: "linear-gradient(90deg,#2563eb,#22c55e)",
  borderRadius: 999,
  transition: "width 0.12s linear",
};

const progressTextStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#94a3b8",
  marginTop: 4,
};

const itemMessageStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#cbd5e1",
  marginTop: 4,
};

const logsStyle: React.CSSProperties = {
  marginTop: 20,
  padding: 12,
  background: "#020617",
  borderRadius: 12,
  border: "1px solid #334155",
  maxHeight: 120,
  overflow: "auto",
  fontSize: 12,
  color: "#94a3b8",
};

const historyPanelStyle: React.CSSProperties = {
  marginTop: 24,
  background: "rgba(17,24,39,0.9)",
  borderRadius: 18,
  padding: 18,
  border: "1px solid rgba(148,163,184,0.25)",
};

const historyHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 12,
};

const historyItemStyle: React.CSSProperties = {
  padding: 12,
  borderRadius: 12,
  background: "#1e293b",
  fontSize: 12,
};

const footerStyle: React.CSSProperties = {
  textAlign: "center",
  marginTop: 32,
  color: "#64748b",
  fontSize: 12,
};

const modalBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.62)",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
};

const modalStyle: React.CSSProperties = {
  background: "#1e293b",
  padding: 26,
  borderRadius: 18,
  width: 480,
  boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
};

export default App;