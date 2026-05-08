use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone)]
struct DownloadState {
    cancel_flag: Arc<AtomicBool>,
}

#[derive(Debug, Serialize, Deserialize)]
struct VideoInfo {
    title: String,
    uploader: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    webpage_url: Option<String>,
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
    {
        return find_bundled_binary(app, &["yt-dlp-x86_64-pc-windows-msvc.exe"]);
    }

    #[cfg(target_os = "macos")]
    {
        return find_bundled_binary(app, &["yt-dlp-universal-apple-darwin"]);
    }

    Err("このOS用の yt-dlp が見つかりませんでした".to_string())
}

fn ffmpeg_location(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let local = PathBuf::from("/usr/local/bin/ffmpeg");
        if local.exists() {
            return Ok(local);
        }
    }

    #[cfg(target_os = "windows")]
    {
        return find_bundled_binary(app, &["ffmpeg-x86_64-pc-windows-msvc.exe"]);
    }

    #[cfg(target_os = "macos")]
    {
        return find_bundled_binary(app, &["ffmpeg-universal-apple-darwin"]);
    }

    Err("このOS用の ffmpeg が見つかりませんでした".to_string())
}

fn ffprobe_location(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let local = PathBuf::from("/usr/local/bin/ffprobe");
        if local.exists() {
            return Ok(local);
        }
    }

    #[cfg(target_os = "windows")]
    {
        return find_bundled_binary(app, &["ffprobe-x86_64-pc-windows-msvc.exe"]);
    }

    #[cfg(target_os = "macos")]
    {
        return find_bundled_binary(app, &["ffprobe-universal-apple-darwin"]);
    }

    Err("このOS用の ffprobe が見つかりませんでした".to_string())
}

fn default_download_dir() -> Result<String, String> {
    dirs::download_dir()
        .ok_or_else(|| "Downloads フォルダを取得できませんでした".to_string())
        .map(|p| p.to_string_lossy().to_string())
}

fn add_cookie_browser_arg(command: &mut Command, cookie_browser: Option<String>) {
    if let Some(browser) = cookie_browser {
        let browser = browser.trim();
        if !browser.is_empty() && browser != "none" {
            command.arg("--cookies-from-browser").arg(browser);
        }
    }
}

fn emit_log(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit("download-log", message.into());
}

fn emit_progress(app: &AppHandle, percent: f64) {
    let _ = app.emit("download-progress", percent);
}

#[tauri::command]
fn get_default_download_dir() -> Result<String, String> {
    default_download_dir()
}

#[tauri::command]
fn cancel_download(state: State<Mutex<DownloadState>>) -> Result<(), String> {
    let state = state.lock().map_err(|_| "state lock error".to_string())?;
    state.cancel_flag.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn get_video_info(
    app: AppHandle,
    url: String,
    cookie_browser: Option<String>,
) -> Result<VideoInfo, String> {
    let yt_dlp = yt_dlp_path(&app)?;

    emit_log(&app, format!("yt-dlp: {}", yt_dlp.display()));

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
        return Err(format!("動画情報の取得に失敗しました:\n{}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    let value: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("動画情報JSONの解析に失敗しました: {}", e))?;

    Ok(VideoInfo {
        title: value
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown Title")
            .to_string(),
        uploader: value
            .get("uploader")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        duration: value.get("duration").and_then(|v| v.as_f64()),
        thumbnail: value
            .get("thumbnail")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        webpage_url: value
            .get("webpage_url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

#[tauri::command]
fn download_video(
    app: AppHandle,
    state: State<Mutex<DownloadState>>,
    url: String,
    save_dir: Option<String>,
    format_id: Option<String>,
    cookie_browser: Option<String>,
) -> Result<String, String> {
    {
        let state = state.lock().map_err(|_| "state lock error".to_string())?;
        state.cancel_flag.store(false, Ordering::SeqCst);
    }

    let yt_dlp = yt_dlp_path(&app)?;
    let ffmpeg = ffmpeg_location(&app)?;
    let _ffprobe = ffprobe_location(&app).ok();

    let output_dir = match save_dir {
        Some(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(default_download_dir()?),
    };

    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("保存先フォルダを作成できませんでした: {}", e))?;

    emit_log(&app, format!("保存先: {}", output_dir.display()));
    emit_log(&app, format!("yt-dlp: {}", yt_dlp.display()));
    emit_log(&app, format!("ffmpeg: {}", ffmpeg.display()));

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
        .arg("--merge-output-format")
        .arg("mp4")
        .arg("-o")
        .arg(output_template);

    match format_id {
        Some(fmt) if !fmt.trim().is_empty() => {
            command.arg("-f").arg(fmt);
        }
        _ => {
            command
                .arg("-f")
                .arg("bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best");
        }
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

        thread::spawn(move || {
            let reader = BufReader::new(stdout);

            for line in reader.lines().flatten() {
                emit_log(&app_clone, line.clone());

                if let Some(percent) = parse_progress_percent(&line) {
                    emit_progress(&app_clone, percent);
                }
            }
        });
    }

    if let Some(stderr) = stderr {
        let app_clone = app.clone();

        thread::spawn(move || {
            let reader = BufReader::new(stderr);

            for line in reader.lines().flatten() {
                emit_log(&app_clone, line);
            }
        });
    }

    loop {
        {
            let state = state.lock().map_err(|_| "state lock error".to_string())?;
            if state.cancel_flag.load(Ordering::SeqCst) {
                let _ = child.kill();
                emit_log(&app, "ダウンロードを停止しました");
                return Err("ダウンロードを停止しました".to_string());
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    emit_progress(&app, 100.0);
                    emit_log(&app, "ダウンロード完了");
                    return Ok("ダウンロード完了".to_string());
                } else {
                    return Err(format!("ダウンロードに失敗しました: {}", status));
                }
            }
            Ok(None) => {
                thread::sleep(Duration::from_millis(300));
            }
            Err(e) => {
                return Err(format!("プロセス監視に失敗しました: {}", e));
            }
        }
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(DownloadState {
            cancel_flag: Arc::new(AtomicBool::new(false)),
        }))
        .invoke_handler(tauri::generate_handler![
            get_default_download_dir,
            get_video_info,
            download_video,
            cancel_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}