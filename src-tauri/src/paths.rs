use std::path::PathBuf;
use tauri::{AppHandle, Manager};

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

pub fn yt_dlp_path(app: &AppHandle) -> Result<PathBuf, String> {
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

pub fn ffmpeg_location(app: &AppHandle) -> Result<PathBuf, String> {
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