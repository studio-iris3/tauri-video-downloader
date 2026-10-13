use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use crate::paths::yt_dlp_update_dir;

static UPDATE_LOCK: Mutex<()> = Mutex::new(());
const RELEASE_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const MAX_BINARY_SIZE: u64 = 160 * 1024 * 1024;
const MANIFEST_NAME: &str = "active-yt-dlp.json";

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}
#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}
#[derive(Debug)]
pub struct UpdateInfo {
    pub version: String,
    pub download_url: String,
    pub checksum_url: String,
    pub filename: String,
}
#[derive(Debug, Serialize, Deserialize)]
struct ActiveUpdate {
    version: String,
    filename: String,
    sha256: String,
}

fn parse_version(v: &str) -> Result<(u32, u32, u32), String> {
    let parts: Vec<&str> = v.split('.').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2
        || !parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit())) {
        return Err(format!("未対応のyt-dlpバージョン形式です: {v}"));
    }
    let y = parts[0].parse::<u32>().map_err(|e| e.to_string())?;
    let m = parts[1].parse::<u32>().map_err(|e| e.to_string())?;
    let d = parts[2].parse::<u32>().map_err(|e| e.to_string())?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Err(format!("不正なyt-dlp日付です: {v}"));
    }
    Ok((y, m, d))
}
fn sha256_hex(data: &[u8]) -> String { hex::encode(Sha256::digest(data)) }
fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("ファイルを開けません: {e}"))?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("ファイル読込失敗: {e}"))?;
        if n == 0 { break; }
        hash.update(&buf[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}
fn version_of(path: &Path) -> Result<String, String> {
    let output = Command::new(path).arg("--version").output()
        .map_err(|e| format!("yt-dlp起動失敗: {e}"))?;
    if !output.status.success() {
        return Err(format!("yt-dlp実行失敗: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
    parse_version(&v)?;
    Ok(v)
}

pub fn check_latest_version() -> Result<UpdateInfo, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("Studio-Iris-Video-Downloader")
        .timeout(Duration::from_secs(25)).build()
        .map_err(|e| format!("通信の準備に失敗: {e}"))?;
    let release: GitHubRelease = client.get(RELEASE_API).send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("GitHubへの接続に失敗: {e}"))?
        .json().map_err(|e| format!("リリース情報の解析に失敗: {e}"))?;
    parse_version(&release.tag_name)?;
    #[cfg(target_os = "macos")]
    let filename = "yt-dlp_macos";
    #[cfg(target_os = "windows")]
    let filename = "yt-dlp.exe";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("未対応のOSです".to_string());
    let binary = release.assets.iter().find(|a| a.name == filename)
        .ok_or_else(|| "対応するyt-dlpがありません".to_string())?;
    let checksum = release.assets.iter().find(|a| a.name == "SHA2-256SUMS")
        .ok_or_else(|| "公式チェックサムがありません".to_string())?;
    Ok(UpdateInfo {
        version: release.tag_name,
        download_url: binary.browser_download_url.clone(),
        checksum_url: checksum.browser_download_url.clone(),
        filename: filename.to_string(),
    })
}

fn expected_sha256(checksums: &str, name: &str) -> Result<String, String> {
    for line in checksums.lines() {
        let mut tokens = line.split_whitespace();
        if let (Some(hash), Some(filename)) = (tokens.next(), tokens.next()) {
            if filename.trim_start_matches('*') == name {
                if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Err("SHA-256チェックサムの形式が不正です".to_string());
                }
                return Ok(hash.to_ascii_lowercase());
            }
        }
    }
    Err(format!("チェックサム一覧に {name} がありません"))
}

fn download_verified_update(info: &UpdateInfo) -> Result<(Vec<u8>, String), String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("Studio-Iris-Video-Downloader")
        .timeout(Duration::from_secs(180)).build()
        .map_err(|e| format!("通信の準備に失敗: {e}"))?;
    let checksums = client.get(&info.checksum_url).send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("チェックサム取得失敗: {e}"))?
        .text().map_err(|e| format!("チェックサム読込失敗: {e}"))?;
    let expected = expected_sha256(&checksums, &info.filename)?;
    let mut response = client.get(&info.download_url).send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("yt-dlpダウンロード失敗: {e}"))?;
    if response.content_length().is_some_and(|n| n > MAX_BINARY_SIZE) {
        return Err("yt-dlpが想定サイズを超えています".to_string());
    }
    let mut bytes = Vec::new();
    response.by_ref().take(MAX_BINARY_SIZE + 1).read_to_end(&mut bytes)
        .map_err(|e| format!("yt-dlp読込失敗: {e}"))?;
    if bytes.len() as u64 > MAX_BINARY_SIZE {
        return Err("yt-dlpが想定サイズを超えています".to_string());
    }
    let actual = sha256_hex(&bytes);
    if actual != expected {
        return Err(format!("SHA-256が一致しません。期待: {expected} / 実際: {actual}"));
    }
    Ok((bytes, actual))
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path).map_err(|e| e.to_string())?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).map_err(|e| e.to_string())
}
#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), String> { Ok(()) }

fn ensure_filename(manifest: &ActiveUpdate) -> Result<(), String> {
    parse_version(&manifest.version)?;
    if manifest.sha256.len() != 64 || !manifest.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("保存されたチェックサムが不正です".to_string());
    }
    #[cfg(target_os = "macos")]
    let extension = "";
    #[cfg(target_os = "windows")]
    let extension = ".exe";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("未対応のOSです".to_string());
    let expected_name = format!("yt-dlp-{}-{}{}", manifest.version, &manifest.sha256[..16], extension);
    if manifest.filename != expected_name {
        return Err("更新ファイル名が管理情報と一致しません".to_string());
    }
    Ok(())
}

pub fn validated_update_path(app: &AppHandle, bundled: &Path) -> Result<Option<PathBuf>, String> {
    let dir = yt_dlp_update_dir(app)?;
    let manifest_path = dir.join(MANIFEST_NAME);
    if !manifest_path.is_file() { return Ok(None); }
    let manifest: ActiveUpdate = serde_json::from_slice(&fs::read(&manifest_path)
        .map_err(|e| format!("更新管理情報読込失敗: {e}"))?)
        .map_err(|e| format!("更新管理情報解析失敗: {e}"))?;
    ensure_filename(&manifest)?;
    let path = dir.join(&manifest.filename);
    if !path.is_file() { return Err("更新版yt-dlpが見つかりません".to_string()); }
    if hash_file(&path)? != manifest.sha256.to_ascii_lowercase() {
        return Err("更新版yt-dlpのSHA-256が一致しません".to_string());
    }
    // 同梱版より古い更新版は選ばない。
    let bundled_version = version_of(bundled)?;
    if parse_version(&manifest.version)? < parse_version(&bundled_version)? {
        return Ok(None);
    }
    Ok(Some(path))
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos()).unwrap_or_default();
    format!("{}-{nanos}", std::process::id())
}

fn write_manifest(dir: &Path, manifest: &ActiveUpdate) -> Result<(), String> {
    let target = dir.join(MANIFEST_NAME);
    let staging = dir.join(format!("active-yt-dlp-{}.tmp", unique_suffix()));
    let backup = dir.join("active-yt-dlp.previous.json");
    let data = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
    {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&staging)
            .map_err(|e| format!("管理情報一時ファイル作成失敗: {e}"))?;
        file.write_all(&data).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    // Windowsでも動作するよう、古い管理情報を退避してから切替。
    if target.exists() {
        if backup.exists() { fs::remove_file(&backup).map_err(|e| e.to_string())?; }
        fs::rename(&target, &backup).map_err(|e| format!("旧管理情報退避失敗: {e}"))?;
    }
    if let Err(err) = fs::rename(&staging, &target) {
        if backup.exists() { let _ = fs::rename(&backup, &target); }
        let _ = fs::remove_file(&staging);
        return Err(format!("更新版の有効化に失敗: {err}"));
    }
    Ok(())
}

pub fn install_verified_update(app: &AppHandle, info: &UpdateInfo) -> Result<String, String> {
    let _guard = UPDATE_LOCK.try_lock()
        .map_err(|_| "yt-dlpは現在更新中です。完了後に再試行してください。".to_string())?;
    parse_version(&info.version)?;
    let current_path = crate::paths::yt_dlp_path(app)?;
    let current_version = version_of(&current_path)?;
    if parse_version(&info.version)? <= parse_version(&current_version)? {
        return Ok(format!("更新不要です。使用中: {current_version} / 最新: {}", info.version));
    }
    let (bytes, sha256) = download_verified_update(info)?;
    let dir = yt_dlp_update_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("更新フォルダ作成失敗: {e}"))?;
    #[cfg(target_os = "macos")]
    let extension = "";
    #[cfg(target_os = "windows")]
    let extension = ".exe";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("未対応のOSです".to_string());
    let filename = format!("yt-dlp-{}-{}{}", info.version, &sha256[..16], extension);
    let final_path = dir.join(&filename);
    let temp_path = dir.join(format!("yt-dlp-stage-{}{}", unique_suffix(), extension));
    // 一時ファイルはcreate_newで作る。既存のファイルは上書きしない。
    {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp_path)
            .map_err(|e| format!("一時ファイル作成失敗: {e}"))?;
        file.write_all(&bytes).map_err(|e| format!("一時保存失敗: {e}"))?;
        file.sync_all().map_err(|e| format!("同期失敗: {e}"))?;
    }
    let result = (|| -> Result<(), String> {
        set_executable(&temp_path)?;
        if hash_file(&temp_path)? != sha256 { return Err("保存後のSHA-256が異なります".to_string()); }
        let observed = version_of(&temp_path)?;
        if observed != info.version { return Err(format!("バージョン不一致: {observed} != {}", info.version)); }
        if final_path.exists() {
            if hash_file(&final_path)? != sha256 { return Err("同名の更新ファイルが破損しています".to_string()); }
            fs::remove_file(&temp_path).map_err(|e| e.to_string())?;
        } else {
            fs::rename(&temp_path, &final_path).map_err(|e| format!("更新版配置失敗: {e}"))?;
        }
        write_manifest(&dir, &ActiveUpdate { version: info.version.clone(), filename, sha256 })?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temp_path); }
    result?;
    Ok(format!("yt-dlp {} に更新しました: {}", info.version, final_path.display()))
}
