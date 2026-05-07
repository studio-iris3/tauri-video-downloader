use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

struct JobState {
    pids: Mutex<HashMap<String, u32>>,
}

#[derive(Serialize)]
struct VideoInfo {
    title: String,
    thumbnail: String,
}

#[derive(Serialize, Clone)]
struct DownloadProgressPayload {
    job_id: String,
    percent: f64,
}

fn yt_dlp_path() -> String {
    #[cfg(target_os = "macos")]
    {
        "/usr/local/bin/yt-dlp".to_string()
    }

    #[cfg(target_os = "windows")]
    {
        "yt-dlp.exe".to_string()
    }

    #[cfg(target_os = "linux")]
    {
        "yt-dlp".to_string()
    }
}

fn ffmpeg_location(app: &AppHandle) -> Result<String, String> {
    #[cfg(all(target_os = "macos", debug_assertions))]
    {
        return Ok("/usr/local/bin/ffmpeg".to_string());
    }

    #[cfg(target_os = "macos")]
    let ffmpeg_name = if cfg!(target_arch = "aarch64") {
        "ffmpeg-aarch64-apple-darwin"
    } else {
        "ffmpeg-x86_64-apple-darwin"
    };

    #[cfg(target_os = "windows")]
    let ffmpeg_name = "ffmpeg-x86_64-pc-windows-msvc.exe";

    #[cfg(target_os = "linux")]
    let ffmpeg_name = "ffmpeg-x86_64-unknown-linux-gnu";

    let path = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join(ffmpeg_name);

    Ok(path.to_string_lossy().to_string())
}

fn resolve_save_path(save_path: String) -> Result<PathBuf, String> {
    if !save_path.trim().is_empty() {
        return Ok(PathBuf::from(save_path));
    }

    dirs::download_dir()
        .ok_or_else(|| "ダウンロードフォルダを取得できませんでした".to_string())
}

fn add_cookie_args(command: &mut Command, cookie_browser: &str) {
    if cookie_browser != "none" && !cookie_browser.trim().is_empty() {
        command.args(["--cookies-from-browser", cookie_browser]);
    }
}

#[tauri::command]
fn get_default_download_dir() -> Result<String, String> {
    let dir = dirs::download_dir()
        .ok_or_else(|| "ダウンロードフォルダを取得できませんでした".to_string())?;

    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn get_video_info(url: String, cookie_browser: String) -> Result<VideoInfo, String> {
    let mut command = Command::new(yt_dlp_path());

    command.args(["--dump-json", "--no-playlist"]);
    command.args(["--extractor-args", "youtube:player_client=default,ios"]);
    command.arg("--force-ipv4");

    add_cookie_args(&mut command, &cookie_browser);
    command.arg(&url);

    let output = command
        .output()
        .map_err(|e| format!("yt-dlp の実行に失敗しました: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let json_text = String::from_utf8_lossy(&output.stdout);

    let json: serde_json::Value =
        serde_json::from_str(&json_text).map_err(|e| format!("JSON解析エラー: {}", e))?;

    let title = json["title"]
        .as_str()
        .unwrap_or("タイトル不明")
        .to_string();

    let thumbnail = json["thumbnail"]
        .as_str()
        .unwrap_or("")
        .to_string();

    Ok(VideoInfo { title, thumbnail })
}

#[tauri::command]
fn cancel_download(job_id: String, state: State<JobState>) -> Result<String, String> {
    let pid = {
        let mut pids = state
            .pids
            .lock()
            .map_err(|_| "ジョブ管理ロックに失敗しました".to_string())?;

        pids.remove(&job_id)
    };

    if let Some(pid) = pid {
        #[cfg(target_os = "windows")]
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();

        #[cfg(not(target_os = "windows"))]
        let status = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status();

        let status = status.map_err(|e| format!("キャンセルに失敗しました: {}", e))?;

        if status.success() {
            Ok("キャンセルしました".to_string())
        } else {
            Err("プロセスのキャンセルに失敗しました".to_string())
        }
    } else {
        Ok("対象ジョブは実行中ではありません".to_string())
    }
}

#[tauri::command]
fn download_video(
    app: AppHandle,
    state: State<JobState>,
    job_id: String,
    url: String,
    save_path: String,
    format_type: String,
    mp4_quality: String,
    mp3_quality: String,
    cookie_browser: String,
) -> Result<String, String> {
    let save_dir = resolve_save_path(save_path)?;
    let save_dir_text = save_dir.to_string_lossy().to_string();

    let quality_label = if format_type == "mp3" {
        mp3_quality.clone()
    } else if mp4_quality == "best" {
        "best".to_string()
    } else {
        format!("{}p", mp4_quality)
    };

    let output_template = format!("{}/%(title)s_{}.%(ext)s", save_dir_text, quality_label);

    let mut command = Command::new(yt_dlp_path());

    let ffmpeg_path = ffmpeg_location(&app)?;

    command.args(["--ffmpeg-location", &ffmpeg_path]);
    command.args(["--extractor-args", "youtube:player_client=default,ios"]);
    command.arg("--force-ipv4");
    command.args(["-o", &output_template]);
    command.arg("--newline");
    command.arg("--no-playlist");
    command.arg("--prefer-ffmpeg");

    add_cookie_args(&mut command, &cookie_browser);

    if format_type == "mp3" {
        command.args([
            "-f",
            "bestaudio/best",
            "-x",
            "--audio-format",
            "mp3",
            "--audio-quality",
            &mp3_quality,
        ]);

        let _ = app.emit(
            "download-log",
            format!(
                "[{}] MP3で保存します / 保存先: {} / 音質: {} / ffmpeg: {}",
                job_id, save_dir_text, mp3_quality, ffmpeg_path
            ),
        );
    } else {
        let format_selector = match mp4_quality.as_str() {
            "1080" => "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]",
            "720" => "bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]",
            "480" => "bv*[ext=mp4][height<=480]+ba[ext=m4a]/b[ext=mp4][height<=480]",
            _ => "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]",
        };

        command.args([
            "-f",
            format_selector,
            "--merge-output-format",
            "mp4",
            "--remux-video",
            "mp4",
        ]);

        let _ = app.emit(
            "download-log",
            format!(
                "[{}] MP4で保存します / 保存先: {} / 画質: {} / ffmpeg: {}",
                job_id, save_dir_text, quality_label, ffmpeg_path
            ),
        );
    }

    if cookie_browser != "none" {
        let _ = app.emit(
            "download-log",
            format!("[{}] Cookie取得元: {}", job_id, cookie_browser),
        );
    }

    command.arg(&url);

    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("yt-dlp の起動に失敗しました: {}", e))?;

    let pid = child.id();

    {
        let mut pids = state
            .pids
            .lock()
            .map_err(|_| "ジョブ管理ロックに失敗しました".to_string())?;

        pids.insert(job_id.clone(), pid);
    }

    let app_for_stderr = app.clone();
    let job_id_for_stderr = job_id.clone();

    let stderr_handle = child.stderr.take().map(|stderr| {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);

            for line in reader.lines() {
                let line = line.unwrap_or_default();

                if !line.trim().is_empty() {
                    let _ = app_for_stderr.emit(
                        "download-log",
                        format!("[{}] {}", job_id_for_stderr, line),
                    );
                }
            }
        })
    });

    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut last_percent = -1.0;

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);

        for line in reader.lines() {
            let line = line.unwrap_or_default();

            if let Some(percent) = extract_percent(&line) {
                let should_emit =
                    (percent - last_percent).abs() >= 0.5
                        || last_emit.elapsed() >= Duration::from_millis(300);

                if should_emit {
                    let _ = app.emit(
                        "download-progress",
                        DownloadProgressPayload {
                            job_id: job_id.clone(),
                            percent,
                        },
                    );

                    last_percent = percent;
                    last_emit = Instant::now();
                }
            }

            if !line.trim().is_empty() {
                let _ = app.emit("download-log", format!("[{}] {}", job_id, line));
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("yt-dlp の終了待機に失敗しました: {}", e))?;

    if let Some(handle) = stderr_handle {
        let _ = handle.join();
    }

    {
        let mut pids = state
            .pids
            .lock()
            .map_err(|_| "ジョブ管理ロックに失敗しました".to_string())?;

        pids.remove(&job_id);
    }

    if status.success() {
        let _ = app.emit(
            "download-progress",
            DownloadProgressPayload {
                job_id: job_id.clone(),
                percent: 100.0,
            },
        );

        let _ = app.emit("download-log", format!("[{}] ダウンロード完了", job_id));

        Ok(format!("ダウンロード完了: {}", save_dir_text))
    } else {
        Err("ダウンロードまたは結合に失敗しました。ログを確認してください。".to_string())
    }
}

fn extract_percent(line: &str) -> Option<f64> {
    let percent_pos = line.find('%')?;
    let before = &line[..percent_pos];

    let number = before
        .split_whitespace()
        .last()?
        .replace('%', "")
        .trim()
        .to_string();

    number.parse::<f64>().ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(JobState {
            pids: Mutex::new(HashMap::new()),
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