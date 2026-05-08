export type DownloadHistory = {
  title: string;
  url: string;
  date: string;
};

const HISTORY_KEY = "download-history";

export function loadHistory(): DownloadHistory[] {
  try {
    const saved = localStorage.getItem(HISTORY_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

export function saveHistory(history: DownloadHistory[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

export function clearSavedHistory() {
  localStorage.removeItem(HISTORY_KEY);
}