use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone)]
struct DownloadState {
    cancelled_jobs: Arc<Mutex<HashSet<String>>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct VideoInfo {
    title: String,
    thumbnail: String,
}

#[derive(Debug, Clone, Serialize)]
struct ProgressPayload {
    job_id: String,
    percent: f64,
}

#[cfg(unix)]
fn ensure_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;

    if let Ok(metadata) = std::fs::metadata(path) {
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o755);
        let _ = std::fs::set_permissions(path, permissions);
    }
}

#[cfg(not(unix))]
fn ensure_executable(_path: &std::path::Path) {}

fn bundled_bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir の取得に失敗しました: {}", e))?;

    Ok(resource_dir.join("bin"))
}

fn find_bundled_binary(app: &AppHandle, names: &[&str]) -> Result<PathBuf, String> {
    let bin_dir = bundled_bin_dir(app)?;

    for name in names {
        let candidate = bin_dir.join(name);
        if candidate.exists() {
            ensure_executable(&candidate);
            return Ok(candidate);
        }
    }

    Err(format!(
        "同梱バイナリが見つかりませんでした。\n探索先: {}\n候補: {:?}",
        bin_dir.display(),
        names
    ))
}

fn yt_dlp_path(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let local = PathBuf::from("/usr/local/bin/yt-dlp");
        if local.exists() {
            return Ok(local);
        }
    }

    #[cfg(target_os = "windows")]
    let names = &["yt-dlp-x86_64-pc-windows-msvc.exe"];

    #[cfg(target_os = "macos")]
    let names = &["yt-dlp-universal-apple-darwin"];

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return Err("このOS用の yt-dlp が見つかりませんでした".to_string());

    find_bundled_binary(app, names)
}

fn ffmpeg_location(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let local = PathBuf::from("/usr/local/bin/ffmpeg");
        if local.exists() {
            return Ok(local);
        }
    }

    #[cfg(target_os = "windows")]
    let names = &["ffmpeg-x86_64-pc-windows-msvc.exe"];

    #[cfg(target_os = "macos")]
    let names = &["ffmpeg-universal-apple-darwin"];

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return Err("このOS用の ffmpeg が見つかりませんでした".to_string());

    find_bundled_binary(app, names)
}

fn default_download_dir() -> Result<String, String> {
    dirs::download_dir()
        .ok_or_else(|| "Downloads フォルダを取得できませんでした".to_string())
        .map(|p| p.to_string_lossy().to_string())
}

fn emit_log(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit("download-log", message.into());
}

fn emit_progress(app: &AppHandle, job_id: &str, percent: f64) {
    let payload = ProgressPayload {
        job_id: job_id.to_string(),
        percent,
    };

    let _ = app.emit("download-progress", payload);
}

fn parse_progress_percent(line: &str) -> Option<f64> {
    if !line.contains("[download]") || !line.contains('%') {
        return None;
    }

    let percent_pos = line.find('%')?;
    let before_percent = &line[..percent_pos];

    let number_start = before_percent
        .rfind(|c: char| !(c.is_ascii_digit() || c == '.'))
        .map(|i| i + 1)
        .unwrap_or(0);

    before_percent[number_start..].parse::<f64>().ok()
}

fn should_emit_log(line: &str) -> bool {
    let lower = line.to_lowercase();

    lower.contains("error")
        || lower.contains("warning")
        || lower.contains("failed")
        || lower.contains("merging")
        || lower.contains("destination")
        || lower.contains("extracting audio")
        || lower.contains("deleting original")
        || lower.contains("download completed")
}

fn add_cookie_browser_arg(command: &mut Command, cookie_browser: Option<String>) {
    if let Some(browser) = cookie_browser {
        let browser = browser.trim();

        if !browser.is_empty() && browser != "none" {
            command.arg("--cookies-from-browser").arg(browser);
        }
    }
}

fn mp4_format_selector(mp4_quality: &str) -> String {
    match mp4_quality {
        "best" => {
            "bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]"
                .to_string()
        }

        "1080" => {
            "bestvideo[vcodec^=avc1][height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]"
                .to_string()
        }

        "720" => {
            "bestvideo[vcodec^=avc1][height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]"
                .to_string()
        }

        "480" => {
            "bestvideo[vcodec^=avc1][height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]"
                .to_string()
        }

        _ => {
            "bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]"
                .to_string()
        }
    }
}

fn friendly_error(error_text: String) -> String {
    if error_text.contains("Sign in to confirm")
        || error_text.contains("not a bot")
        || error_text.contains("--cookies-from-browser")
    {
        return "YouTubeのbot判定が出ています。Cookie BrowserをChrome/Safari/Firefoxなどログイン済みブラウザに変更して再試行してください。".to_string();
    }

    error_text
}

#[tauri::command]
fn get_default_download_dir() -> Result<String, String> {
    default_download_dir()
}

#[tauri::command]
fn cancel_download(state: State<DownloadState>, job_id: String) -> Result<(), String> {
    let mut cancelled = state
        .cancelled_jobs
        .lock()
        .map_err(|_| "cancel state lock error".to_string())?;

    cancelled.insert(job_id);
    Ok(())
}

#[tauri::command]
fn get_video_info(
    app: AppHandle,
    url: String,
    cookie_browser: Option<String>,
) -> Result<VideoInfo, String> {
    let yt_dlp = yt_dlp_path(&app)?;

    let mut command = Command::new(yt_dlp);

    command
        .arg("--dump-json")
        .arg("--no-playlist")
        .arg("--force-ipv4")
        .arg("--extractor-args")
        .arg("youtube:player_client=default,ios")
        .arg(&url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    add_cookie_browser_arg(&mut command, cookie_browser);

    let output = command
        .output()
        .map_err(|e| format!("動画情報の取得に失敗しました: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(friendly_error(format!("動画情報の取得に失敗しました:\n{}", stderr)));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    let value: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("動画情報JSONの解析に失敗しました: {}", e))?;

    let title = value
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("タイトル未取得")
        .to_string();

    let thumbnail = value
        .get("thumbnail")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(VideoInfo { title, thumbnail })
}

#[tauri::command]
fn download_video(
    app: AppHandle,
    state: State<DownloadState>,
    job_id: String,
    url: String,
    save_path: Option<String>,
    format_type: String,
    mp4_quality: String,
    mp3_quality: String,
    cookie_browser: Option<String>,
) -> Result<String, String> {
    {
        let mut cancelled = state
            .cancelled_jobs
            .lock()
            .map_err(|_| "cancel state lock error".to_string())?;
        cancelled.remove(&job_id);
    }

    let yt_dlp = yt_dlp_path(&app)?;
    let ffmpeg = ffmpeg_location(&app)?;

    let output_dir = match save_path {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path),
        _ => PathBuf::from(default_download_dir()?),
    };

    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("保存先フォルダを作成できませんでした: {}", e))?;

    emit_log(&app, format!("開始: {}", url));
    emit_log(&app, format!("保存先: {}", output_dir.display()));

    let output_template = output_dir.join("%(title).200B.%(ext)s");

    let mut command = Command::new(yt_dlp);

    command
        .arg("--newline")
        .arg("--progress")
        .arg("--no-playlist")
        .arg("--force-ipv4")
        .arg("--extractor-args")
        .arg("youtube:player_client=default,ios")
        .arg("--ffmpeg-location")
        .arg(ffmpeg)
        .arg("-o")
        .arg(output_template);

    if format_type == "mp3" {
        command
            .arg("-f")
            .arg("ba/best")
            .arg("--extract-audio")
            .arg("--audio-format")
            .arg("mp3")
            .arg("--audio-quality")
            .arg(mp3_quality);
    } else {
        command
            .arg("-f")
            .arg(mp4_format_selector(&mp4_quality))
            .arg("--merge-output-format")
            .arg("mp4");
    }

    add_cookie_browser_arg(&mut command, cookie_browser);

    command
        .arg(&url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("yt-dlp の実行に失敗しました: {}", e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Some(stdout) = stdout {
        let app_clone = app.clone();
        let job_id_clone = job_id.clone();

        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut last_progress_emit = Instant::now() - Duration::from_secs(1);

            for line in reader.lines().flatten() {
                if let Some(percent) = parse_progress_percent(&line) {
                    if last_progress_emit.elapsed() >= Duration::from_millis(500) {
                        emit_progress(&app_clone, &job_id_clone, percent);
                        last_progress_emit = Instant::now();
                    }

                    continue;
                }

                if should_emit_log(&line) {
                    emit_log(&app_clone, line);
                }
            }
        });
    }

    if let Some(stderr) = stderr {
        let app_clone = app.clone();

        thread::spawn(move || {
            let reader = BufReader::new(stderr);

            for line in reader.lines().flatten() {
                if should_emit_log(&line) {
                    emit_log(&app_clone, line);
                }
            }
        });
    }

    loop {
        {
            let cancelled = state
                .cancelled_jobs
                .lock()
                .map_err(|_| "cancel state lock error".to_string())?;

            if cancelled.contains(&job_id) {
                let _ = child.kill();
                emit_log(&app, "キャンセルしました");
                return Err("キャンセルしました".to_string());
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    emit_progress(&app, &job_id, 100.0);
                    emit_log(&app, "完了");
                    return Ok("ダウンロード完了".to_string());
                }

                return Err(format!("ダウンロードに失敗しました: {}", status));
            }
            Ok(None) => {
                thread::sleep(Duration::from_millis(500));
            }
            Err(e) => {
                return Err(format!("プロセス監視に失敗しました: {}", e));
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DownloadState {
            cancelled_jobs: Arc::new(Mutex::new(HashSet::new())),
        })
        .invoke_handler(tauri::generate_handler![
            get_default_download_dir,
            get_video_info,
            download_video,
            cancel_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}