#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

mod forge;

use forge::{ForgeBuild, ForgeChannel, ForgeInstallResult, NeoForgeBuild, NeoForgeInstallResult};

#[cfg(windows)]
const JAVA_BIN: &str = "javaw.exe";
#[cfg(not(windows))]
const JAVA_BIN: &str = "java";

#[cfg(windows)]
const CLASSPATH_SEP: &str = ";";
#[cfg(not(windows))]
const CLASSPATH_SEP: &str = ":";

const DEFAULT_MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;
const JAVA_METADATA_MAX_BYTES: u64 = 2 * 1024 * 1024;
const JAVA_ARCHIVE_MAX_BYTES: u64 = 300 * 1024 * 1024;
const JAVA_UNPACK_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const JAVA_MAX_ARCHIVE_ENTRIES: usize = 20_000;
const JAVA_MAX_ENTRY_BYTES: u64 = 500 * 1024 * 1024;
const JAVA_MAX_COMPRESSION_RATIO: u64 = 500;
static TEMP_PATH_COUNTER: OnceLock<AtomicU64> = OnceLock::new();
static BUSY_RUNS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static ACTIVE_FORGE_INSTALLS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static ACTIVE_JAVA_INSTALLS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct RunGuard {
    key: String,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Some(runs) = BUSY_RUNS.get() {
            let mut busy = runs.lock().unwrap_or_else(|error| error.into_inner());
            busy.remove(&self.key);
        }
    }
}

struct ForgeInstallGuard {
    profile_id: String,
}

impl Drop for ForgeInstallGuard {
    fn drop(&mut self) {
        if let Some(installs) = ACTIVE_FORGE_INSTALLS.get() {
            installs
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&self.profile_id);
        }
    }
}

fn acquire_forge_install(profile_id: &str) -> Result<ForgeInstallGuard, String> {
    let installs = ACTIVE_FORGE_INSTALLS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut active = installs.lock().unwrap_or_else(|error| error.into_inner());
    if !active.insert(profile_id.to_string()) {
        return Err("Эта версия загрузчика уже устанавливается".into());
    }
    Ok(ForgeInstallGuard {
        profile_id: profile_id.to_string(),
    })
}

struct JavaInstallGuard {
    major: u32,
}

impl Drop for JavaInstallGuard {
    fn drop(&mut self) {
        if let Some(installs) = ACTIVE_JAVA_INSTALLS.get() {
            installs
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&self.major.to_string());
        }
    }
}

fn acquire_java_install(major: u32) -> Result<JavaInstallGuard, String> {
    let installs = ACTIVE_JAVA_INSTALLS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut active = installs.lock().unwrap_or_else(|error| error.into_inner());
    if !active.insert(major.to_string()) {
        return Err(format!("Java {} уже устанавливается", major));
    }
    Ok(JavaInstallGuard { major })
}

fn acquire_version_run(version_id: &str) -> Result<RunGuard, String> {
    let runs = BUSY_RUNS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut busy = runs.lock().unwrap_or_else(|error| error.into_inner());
    if !busy.insert(version_id.to_string()) {
        return Err("Эта версия уже запущена".into());
    }
    Ok(RunGuard {
        key: version_id.to_string(),
    })
}

struct ProcessFileLock {
    file: fs::File,
}

impl Drop for ProcessFileLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn acquire_process_file_lock(path: &Path) -> Result<ProcessFileLock, String> {
    use std::io::Write;

    let parent = path.parent().unwrap_or(Path::new("."));
    ensure_directory_no_follow(parent)?;
    let file = match fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(path)
                .map_err(|error| format!("Failed to inspect process lock: {}", error))?;
            if is_link_metadata(&metadata) || !metadata.is_file() {
                return Err("Process lock path is not a regular file".into());
            }
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .map_err(|error| format!("Failed to open process lock: {}", error))?
        }
        Err(error) => return Err(format!("Failed to create process lock: {}", error)),
    };

    file.try_lock()
        .map_err(|error| format!("Process lock is busy: {}", error))?;
    let mut lock = ProcessFileLock { file };
    if let Err(error) = lock
        .file
        .set_len(0)
        .and_then(|_| {
            lock.file
                .write_all(std::process::id().to_string().as_bytes())
        })
        .and_then(|_| lock.file.sync_all())
    {
        drop(lock);
        return Err(format!("Failed to write process lock: {}", error));
    }
    Ok(lock)
}

fn named_process_lock_path(name: &str) -> Result<PathBuf, String> {
    validate_safe_component(name, "process lock name")?;
    let directory = get_minecraft_dir().join("canger").join("locks");
    ensure_directory_no_follow(&directory)?;
    Ok(directory.join(name))
}

fn acquire_version_process_lock(version_id: &str) -> Result<ProcessFileLock, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    version_id.hash(&mut hasher);
    let name = format!("version-{:016x}.lock", hasher.finish());
    acquire_process_file_lock(&named_process_lock_path(&name)?)
}

fn acquire_shared_content_process_lock() -> Result<ProcessFileLock, String> {
    acquire_process_file_lock(&named_process_lock_path("shared-content.lock")?)
}

fn acquire_java_process_lock(major: u32) -> Result<ProcessFileLock, String> {
    acquire_process_file_lock(&named_process_lock_path(&format!("java-{}.lock", major))?)
}

const ALLOWED_DOWNLOAD_HOSTS: &[&str] = &[
    "api.modrinth.com",
    "cdn.modrinth.com",
    "api.curseforge.com",
    "mediafilez.forgecdn.net",
    "media.forgecdn.net",
    "edge.forgecdn.net",
    "files.minecraftforge.net",
    "maven.minecraftforge.net",
    "maven.neoforged.net",
    "neoforged.forgecdn.net",
    "piston-meta.mojang.com",
    "piston-data.mojang.com",
    "resources.download.minecraft.net",
    "meta.fabricmc.net",
    "maven.fabricmc.net",
    "launchermeta.mojang.com",
    "libraries.minecraft.net",
    "repo1.maven.org",
    "repo.maven.apache.org",
    "api.adoptium.net",
    "github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

fn is_allowed_remote_url(url: &reqwest::Url) -> bool {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default().unwrap_or(443) != 443
    {
        return false;
    }

    url.host_str()
        .map(|host| ALLOWED_DOWNLOAD_HOSTS.contains(&host.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn restricted_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if is_allowed_remote_url(attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("redirect target is not in the download allowlist")
        }
    })
}

fn build_http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(concat!("canger-launcher/", env!("CARGO_PKG_VERSION")))
        .redirect(restricted_redirect_policy())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

fn temporary_download_path(dest: &Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = TEMP_PATH_COUNTER
        .get_or_init(|| AtomicU64::new(0))
        .fetch_add(1, Ordering::Relaxed);
    let file_name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    dest.with_file_name(format!(
        ".{}.part-{}-{}-{}",
        file_name,
        std::process::id(),
        stamp,
        sequence
    ))
}

#[cfg(windows)]
fn is_link_metadata(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_link_metadata(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn ensure_no_symlink_in_existing_ancestors(path: &Path) -> Result<(), String> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if candidate.as_os_str().is_empty() {
            current = candidate.parent();
            continue;
        }
        match fs::symlink_metadata(candidate) {
            Ok(metadata) => {
                if is_link_metadata(&metadata) {
                    return Err(format!("Refusing symlink path: {}", candidate.display()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to inspect path {}: {}",
                    candidate.display(),
                    error
                ));
            }
        }
        current = candidate.parent();
    }
    Ok(())
}

fn ensure_directory_no_follow(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return ensure_directory_no_follow(Path::new("."));
    }

    let mut missing = Vec::new();
    let mut current = Some(path);
    while let Some(candidate) = current {
        if candidate.as_os_str().is_empty() {
            current = candidate.parent();
            continue;
        }
        match fs::symlink_metadata(candidate) {
            Ok(metadata) => {
                if is_link_metadata(&metadata) {
                    return Err(format!(
                        "Refusing symlink directory: {}",
                        candidate.display()
                    ));
                }
                if !metadata.is_dir() {
                    return Err(format!("Not a directory: {}", candidate.display()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(candidate.to_path_buf());
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect directory {}: {}",
                    candidate.display(),
                    error
                ));
            }
        }
        current = candidate.parent();
    }

    for candidate in missing.into_iter().rev() {
        match fs::create_dir(&candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let metadata = fs::symlink_metadata(&candidate).map_err(|error| {
                    format!(
                        "Failed to inspect directory {}: {}",
                        candidate.display(),
                        error
                    )
                })?;
                if is_link_metadata(&metadata) || !metadata.is_dir() {
                    return Err(format!(
                        "Refusing unsafe directory: {}",
                        candidate.display()
                    ));
                }
            }
            Err(error) => {
                return Err(format!(
                    "Failed to create directory {}: {}",
                    candidate.display(),
                    error
                ));
            }
        }
    }
    Ok(())
}

fn open_regular_file_no_follow(path: &Path) -> Result<fs::File, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect {}: {}", path.display(), error))?;
    if is_link_metadata(&metadata) || !metadata.is_file() {
        return Err(format!("Refusing non-regular file: {}", path.display()));
    }
    fs::File::open(path).map_err(|error| format!("Failed to open {}: {}", path.display(), error))
}

fn is_safe_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_file() && !is_link_metadata(&metadata))
        .unwrap_or(false)
}

fn remove_file_no_follow(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Failed to inspect {}: {}", path.display(), error)),
    };
    if is_link_metadata(&metadata) {
        return fs::remove_file(path)
            .map_err(|error| format!("Failed to remove symlink {}: {}", path.display(), error));
    }
    if !metadata.is_file() {
        return Err(format!("Refusing to remove non-file: {}", path.display()));
    }
    fs::remove_file(path).map_err(|error| format!("Failed to remove {}: {}", path.display(), error))
}

fn remove_tree_no_follow(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Failed to inspect {}: {}", path.display(), error)),
    };
    if is_link_metadata(&metadata) {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(file_error) => fs::remove_dir(path).map_err(|directory_error| {
                format!(
                    "Failed to remove symlink {} ({}; {})",
                    path.display(),
                    file_error,
                    directory_error
                )
            }),
        };
    }
    if !metadata.is_dir() {
        return remove_file_no_follow(path);
    }
    let entries = fs::read_dir(path)
        .map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read an entry: {}", error))?;
        remove_tree_no_follow(&entry.path())?;
    }
    fs::remove_dir(path)
        .map_err(|error| format!("Failed to remove directory {}: {}", path.display(), error))
}

fn create_unique_directory_no_follow(parent: &Path, prefix: &str) -> Result<PathBuf, String> {
    ensure_directory_no_follow(parent)?;
    for _ in 0..16 {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = TEMP_PATH_COUNTER
            .get_or_init(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            "{}{}-{}-{}",
            prefix,
            std::process::id(),
            stamp,
            sequence
        ));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to create staging directory {}: {}",
                    candidate.display(),
                    error
                ));
            }
        }
    }
    Err("Could not allocate a unique staging directory".into())
}

fn create_unique_file_no_follow(
    parent: &Path,
    prefix: &str,
    suffix: &str,
) -> Result<(PathBuf, fs::File), String> {
    ensure_directory_no_follow(parent)?;
    for _ in 0..16 {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = TEMP_PATH_COUNTER
            .get_or_init(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            "{}{}-{}-{}{}",
            prefix,
            std::process::id(),
            stamp,
            sequence,
            suffix
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to create unique file {}: {}",
                    candidate.display(),
                    error
                ));
            }
        }
    }
    Err("Could not allocate a unique file".into())
}

fn create_temporary_download(dest: &Path) -> Result<(PathBuf, fs::File), String> {
    let parent = dest.parent().unwrap_or(Path::new("."));
    ensure_directory_no_follow(parent)?;
    for _ in 0..16 {
        let temp = temporary_download_path(dest);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
        {
            Ok(file) => return Ok((temp, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to create temporary download {}: {}",
                    temp.display(),
                    error
                ));
            }
        }
    }
    Err("Could not allocate a unique temporary download".into())
}

#[cfg(windows)]
fn replace_file_atomically(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    let source_wide: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(format!(
            "Failed to atomically move download to {}: {}",
            destination.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file_atomically(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| {
        format!(
            "Failed to atomically move download to {}: {}",
            destination.display(),
            error
        )
    })
}

fn commit_download(temp: &Path, dest: &Path) -> Result<(), String> {
    let temp_metadata = fs::symlink_metadata(temp)
        .map_err(|error| format!("Failed to inspect temporary download: {}", error))?;
    if is_link_metadata(&temp_metadata) || !temp_metadata.is_file() {
        return Err("Refusing to commit a non-regular temporary download".into());
    }
    if let Ok(metadata) = fs::symlink_metadata(dest) {
        if is_link_metadata(&metadata) {
            return Err(format!("Refusing to replace symlink {}", dest.display()));
        }
        if !metadata.is_file() {
            return Err(format!("Refusing to replace non-file {}", dest.display()));
        }
    }
    ensure_no_symlink_in_existing_ancestors(dest)?;
    replace_file_atomically(temp, dest)
}

async fn download_file_http_limited(url: &str, dest: &Path, max_bytes: u64) -> Result<u64, String> {
    download_file_http_limited_with_expected_size(url, dest, max_bytes, None).await
}

async fn download_file_http_limited_with_expected_size(
    url: &str,
    dest: &Path,
    max_bytes: u64,
    expected_size: Option<u64>,
) -> Result<u64, String> {
    validate_url(url)?;
    if max_bytes == 0 {
        return Err("Download safety limit must be greater than zero".into());
    }
    if expected_size.is_some_and(|size| size == 0 || size > max_bytes) {
        return Err("Expected download size is outside the safety limit".into());
    }
    let client = build_http_client(Duration::from_secs(120))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }
    if let Some(content_length) = response.content_length() {
        if content_length > max_bytes {
            return Err(format!(
                "Download exceeds the {} MiB safety limit",
                max_bytes / 1024 / 1024
            ));
        }
        if expected_size.is_some_and(|expected| content_length != expected) {
            return Err(format!(
                "Download size mismatch: expected {}, got {}",
                expected_size.unwrap_or(0),
                content_length
            ));
        }
    }

    let (temp, mut file) = create_temporary_download(dest)?;
    let result = async {
        use futures_util::StreamExt;
        use std::io::Write;

        let mut downloaded = 0u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| format!("Download error: {}", e))?;
            downloaded = downloaded
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| "Downloaded size overflow".to_string())?;
            if downloaded > max_bytes {
                return Err(format!(
                    "Download exceeds the {} MiB safety limit",
                    max_bytes / 1024 / 1024
                ));
            }
            if expected_size.is_some_and(|expected| downloaded > expected) {
                return Err(format!(
                    "Download exceeds expected size of {} bytes",
                    expected_size.unwrap_or(0)
                ));
            }
            file.write_all(&chunk)
                .map_err(|e| format!("Write error: {}", e))?;
        }
        if downloaded == 0 {
            return Err("Downloaded file is empty".into());
        }
        if expected_size.is_some_and(|expected| downloaded != expected) {
            return Err(format!(
                "Download size mismatch: expected {}, got {}",
                expected_size.unwrap_or(0),
                downloaded
            ));
        }
        file.sync_all()
            .map_err(|e| format!("Failed to flush download: {}", e))?;
        drop(file);
        commit_download(&temp, dest)?;
        Ok(downloaded)
    }
    .await;

    if result.is_err() {
        let _ = remove_file_no_follow(&temp);
    }
    result
}

async fn download_file_http(url: &str, dest: &Path) -> Result<(), String> {
    download_file_http_limited(url, dest, DEFAULT_MAX_DOWNLOAD_BYTES)
        .await
        .map(|_| ())
}

async fn fetch_text_limited(url: &str, max_bytes: u64) -> Result<String, String> {
    validate_url(url)?;
    let client = build_http_client(Duration::from_secs(60))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("HTTP request failed: {}", error))?;
    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }
    if response.content_length().unwrap_or(0) > max_bytes {
        return Err("Response exceeds the configured safety limit".into());
    }
    use futures_util::StreamExt;
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Download error: {}", error))?;
        if bytes.len() as u64 + chunk.len() as u64 > max_bytes {
            return Err("Response exceeds the configured safety limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "Server returned non-UTF-8 data".into())
}

async fn download_file_with_progress(
    url: &str,
    dest: &Path,
    expected_size: u64,
    on_progress: impl Fn(u64, u64) + Send + 'static,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write;

    validate_url(url)?;
    if expected_size > DEFAULT_MAX_DOWNLOAD_BYTES {
        return Err("Expected download exceeds the 1 GiB safety limit".into());
    }
    let client = build_http_client(Duration::from_secs(900))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }
    if let Some(content_length) = response.content_length() {
        if expected_size != 0 && content_length != expected_size {
            return Err(format!(
                "Download size mismatch: expected {}, got {}",
                expected_size, content_length
            ));
        }
        if content_length > DEFAULT_MAX_DOWNLOAD_BYTES {
            return Err("Download exceeds the 1 GiB safety limit".into());
        }
    }
    let total_size = response.content_length().unwrap_or(expected_size);

    let (temp, mut file) = create_temporary_download(dest)?;
    let result = async {
        let mut downloaded = 0u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk_result) = stream.next().await {
            let chunk = chunk_result.map_err(|e| format!("Download error: {}", e))?;
            downloaded = downloaded
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| "Downloaded size overflow".to_string())?;
            if downloaded > DEFAULT_MAX_DOWNLOAD_BYTES {
                return Err("Download exceeds the 1 GiB safety limit".into());
            }
            if expected_size != 0 && downloaded > expected_size {
                return Err(format!(
                    "Download exceeds expected size of {} bytes",
                    expected_size
                ));
            }
            file.write_all(&chunk)
                .map_err(|e| format!("Write error: {}", e))?;
            on_progress(downloaded, total_size);
        }
        if downloaded == 0 {
            return Err("Downloaded file is empty".into());
        }
        if expected_size != 0 && downloaded != expected_size {
            return Err(format!(
                "Download size mismatch: expected {}, got {}",
                expected_size, downloaded
            ));
        }
        file.sync_all()
            .map_err(|e| format!("Failed to flush download: {}", e))?;
        drop(file);
        commit_download(&temp, dest)
    }
    .await;

    if result.is_err() {
        let _ = remove_file_no_follow(&temp);
    }
    result
}

fn get_minecraft_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join(".minecraft");
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            return home
                .join("Library")
                .join("Application Support")
                .join("minecraft");
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(home) = dirs::home_dir() {
            return home.join(".minecraft");
        }
    }

    if let Some(data_dir) = dirs::data_dir() {
        return data_dir.join(".minecraft");
    }
    PathBuf::from(".minecraft")
}

fn launcher_settings_path() -> PathBuf {
    get_minecraft_dir().join("canger").join("settings.json")
}

fn read_launcher_settings() -> serde_json::Value {
    fs::read_to_string(launcher_settings_path())
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .filter(|value: &serde_json::Value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn is_valid_curseforge_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 256
        && key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn stored_curseforge_key() -> Option<String> {
    let settings = read_launcher_settings();
    let key = settings["curseforgeApiKey"].as_str()?.trim();
    if is_valid_curseforge_key(key) {
        Some(key.to_string())
    } else {
        None
    }
}

fn resolve_curseforge_key() -> Option<String> {
    if let Ok(key) = std::env::var("CANGER_CURSEFORGE_API_KEY") {
        let trimmed = key.trim();
        if is_valid_curseforge_key(trimmed) {
            return Some(trimmed.to_string());
        }
    }
    stored_curseforge_key()
}

#[cfg(windows)]
fn trusted_explorer_path() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

    let mut buffer = [0u16; 260];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if length == 0 || length as usize >= buffer.len() {
        return None;
    }

    let system_dir = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length as usize]));
    let explorer = system_dir.join("explorer.exe");
    let metadata = fs::symlink_metadata(&explorer).ok()?;
    if !metadata.is_file() || is_link_metadata(&metadata) {
        return None;
    }
    Some(explorer)
}

fn open_in_file_manager(path: &Path, reveal_file: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let explorer = trusted_explorer_path()
            .ok_or_else(|| "Не удалось найти системный проводник Windows".to_string())?;
        let mut command = Command::new(explorer);
        if reveal_file && path.is_file() {
            command.arg(format!("/select,{}", path.display()));
        } else {
            command.arg(path);
        }
        command
            .spawn()
            .map_err(|error| format!("Не удалось открыть проводник: {}", error))?;
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("/usr/bin/open");
        if reveal_file && path.is_file() {
            command.arg("-R");
        }
        command
            .arg(path)
            .spawn()
            .map_err(|error| format!("Не удалось открыть Finder: {}", error))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let executable = ["/usr/bin/xdg-open", "/bin/xdg-open"]
            .into_iter()
            .map(PathBuf::from)
            .find(|candidate| candidate.is_file())
            .ok_or_else(|| "xdg-open not found".to_string())?;
        let target = if reveal_file && path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        };
        Command::new(executable)
            .arg(target)
            .spawn()
            .map_err(|error| format!("Не удалось открыть папку: {}", error))?;
    }
    Ok(())
}

fn validate_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| format!("Malformed download URL ({url}): {error}"))?;
    if !is_allowed_remote_url(&parsed) {
        return Err(format!(
            "Download URL is not an allowed HTTPS origin: {url}"
        ));
    }
    Ok(())
}

fn validate_version_metadata_url(url: &str, allow_fabric: bool) -> Result<(), String> {
    validate_url(url)?;
    let parsed =
        reqwest::Url::parse(url).map_err(|_| "Malformed version metadata URL".to_string())?;
    let host = parsed.host_str().unwrap_or_default();
    let path = parsed.path();
    let mojang = host.eq_ignore_ascii_case("piston-meta.mojang.com")
        && (path.starts_with("/mc/game/") || path.starts_with("/v1/packages/"))
        && path.ends_with(".json")
        && parsed.query().is_none()
        && parsed.fragment().is_none();
    let fabric = allow_fabric
        && host.eq_ignore_ascii_case("meta.fabricmc.net")
        && path.starts_with("/v2/versions/loader/")
        && path.ends_with("/profile/json");
    if mojang || fabric {
        Ok(())
    } else {
        Err("Version metadata URL is not an official Mojang/Fabric endpoint".into())
    }
}

fn validate_safe_component(value: &str, label: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if value.is_empty() || trimmed.is_empty() || value != trimmed {
        return Err(format!("Invalid {}", label));
    }
    if value == "." || value == ".." || value.len() > 160 {
        return Err(format!("Invalid {}", label));
    }
    if value.chars().any(|ch| {
        ch == '/'
            || ch == '\\'
            || ch == ':'
            || ch == '\0'
            || ch.is_control()
            || matches!(ch, '<' | '>' | '"' | '|' | '?' | '*')
    }) {
        return Err(format!("Invalid {}", label));
    }

    let stem_upper = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    const WINDOWS_RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if WINDOWS_RESERVED.contains(&stem_upper.as_str()) || value.ends_with('.') {
        return Err(format!("Invalid {}", label));
    }
    Ok(())
}

fn validate_version_id(version_id: &str) -> Result<(), String> {
    validate_safe_component(version_id, "version id")
}

fn version_directory(minecraft_dir: &Path, version_id: &str) -> Result<PathBuf, String> {
    validate_version_id(version_id)?;
    Ok(minecraft_dir.join("versions").join(version_id))
}

fn version_json_path(minecraft_dir: &Path, version_id: &str) -> Result<PathBuf, String> {
    Ok(version_directory(minecraft_dir, version_id)?.join(format!("{}.json", version_id)))
}

fn version_game_dir(minecraft_dir: &Path, version_id: &str) -> Result<PathBuf, String> {
    let directory = version_directory(minecraft_dir, version_id)?;
    ensure_directory_no_follow(&directory)
        .map_err(|error| format!("Failed to create version game directory: {error}"))?;
    ensure_directory_no_follow(&directory.join("mods"))
        .map_err(|error| format!("Failed to create version mods directory: {error}"))?;
    Ok(directory)
}

fn resolve_game_dir(version: &str) -> Result<PathBuf, String> {
    if version.trim().is_empty() {
        return Err("Выберите версию Minecraft".into());
    }
    version_game_dir(&get_minecraft_dir(), version)
}

fn validate_mod_filename(filename: &str) -> Result<(), String> {
    validate_safe_component(filename, "file name")?;
    let lower = filename.to_ascii_lowercase();
    if !lower.ends_with(".jar") && !lower.ends_with(".jar.disabled") {
        return Err("Mod file must use the .jar extension".into());
    }
    Ok(())
}

fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.starts_with('/') || value.starts_with('\\') || value.contains('\0')
    {
        return Err("Unsafe relative path".into());
    }
    let mut result = PathBuf::new();
    for part in value.split(['/', '\\']) {
        validate_safe_component(part, "path component")?;
        result.push(part);
    }
    Ok(result)
}

fn normalize_sha1(value: &str) -> Result<String, String> {
    let candidate = value
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if candidate.len() != 40 || !candidate.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid SHA-1 checksum".into());
    }
    Ok(candidate)
}

fn sha1_file(path: &Path) -> Result<String, String> {
    use sha1::{Digest, Sha1};
    use std::io::Read;

    let mut file = open_regular_file_no_follow(path)?;
    let mut hasher = Sha1::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn verify_sha1(path: &Path, expected: &str) -> Result<(), String> {
    let expected = normalize_sha1(expected)?;
    let actual = sha1_file(path)?;
    if actual != expected {
        return Err(format!(
            "SHA-1 mismatch for {}: expected {}, got {}",
            path.display(),
            expected,
            actual
        ));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let mut file = open_regular_file_no_follow(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn sha512_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha512};
    use std::io::Read;

    let mut file = open_regular_file_no_follow(path)?;
    let mut hasher = Sha512::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn verify_sha512(path: &Path, expected: &str) -> Result<(), String> {
    let expected = expected.trim().to_ascii_lowercase();
    if expected.len() != 128 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid SHA-512 checksum".into());
    }
    let actual = sha512_file(path)?;
    if actual != expected {
        return Err(format!(
            "SHA-512 mismatch for {}: expected {}, got {}",
            path.display(),
            expected,
            actual
        ));
    }
    Ok(())
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let expected = expected.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid SHA-256 checksum".into());
    }
    let actual = sha256_file(path)?;
    if actual != expected {
        return Err(format!(
            "SHA-256 mismatch for {}: expected {}, got {}",
            path.display(),
            expected,
            actual
        ));
    }
    Ok(())
}

fn validate_subpath(mc_dir: &Path, subpath: &str) -> Result<PathBuf, String> {
    let trimmed = subpath.trim().trim_matches(&['/', '\\'][..]);
    fs::create_dir_all(mc_dir).map_err(|e| format!("Failed to create game directory: {}", e))?;
    if trimmed.is_empty() {
        return mc_dir.canonicalize().map_err(|e| e.to_string());
    }

    let relative = safe_relative_path(trimmed)?;
    let target = mc_dir.join(relative);

    if target.exists() {
        let metadata = target
            .symlink_metadata()
            .map_err(|e| format!("Cannot read path metadata: {}", e))?;
        if is_link_metadata(&metadata) {
            return Err("Symlinks are not allowed in game directory paths".into());
        }
    }

    let canonical = target
        .canonicalize()
        .or_else(|_| {
            target
                .parent()
                .and_then(|parent| {
                    if parent.exists() {
                        parent
                            .canonicalize()
                            .ok()
                            .and_then(|base| target.file_name().map(|name| base.join(name)))
                    } else {
                        None
                    }
                })
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "Invalid path"))
        })
        .map_err(|e| format!("Invalid path: {}", e))?;
    let mc_canonical = mc_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve game directory: {}", e))?;

    if !canonical.starts_with(&mc_canonical) {
        return Err("Path traversal attempt detected".into());
    }

    Ok(canonical)
}

#[derive(Clone, Serialize, Deserialize)]
struct ProgressPayload {
    version: String,
    percent: u32,
    current: u64,
    total: u64,
    stage: String,
}

fn numeric_runs(value: &str) -> Vec<u64> {
    let mut numbers = Vec::new();
    let mut current = String::new();
    for character in value.chars() {
        if character.is_ascii_digit() {
            if current.len() < 6 {
                current.push(character);
            }
        } else if !current.is_empty() {
            numbers.push(current.parse().unwrap_or(0));
            current.clear();
        }
    }
    if !current.is_empty() {
        numbers.push(current.parse().unwrap_or(0));
    }
    numbers
}

fn version_sort_key(id: &str) -> (Vec<u64>, String) {
    let lower = id.to_ascii_lowercase();
    let cut = [
        "neoforge",
        "forge",
        "fabric",
        "quilt",
        "optifine",
        "liteloader",
        "bukkit",
        "paper",
    ]
    .iter()
    .filter_map(|marker| lower.find(marker))
    .min()
    .unwrap_or(lower.len());
    (numeric_runs(&lower[..cut]), id.to_string())
}

#[tauri::command]
fn get_installed_versions() -> Result<Vec<String>, String> {
    let versions_dir = get_minecraft_dir().join("versions");
    if !versions_dir.exists() {
        return Ok(Vec::new());
    }

    let mut installed = Vec::new();
    if let Ok(entries) = fs::read_dir(&versions_dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if validate_version_id(&name).is_err() {
                    continue;
                }
                let json_path = entry.path().join(format!("{}.json", name));
                let jar_path = entry.path().join(format!("{}.jar", name));
                let mut jar_valid = fs::metadata(&jar_path)
                    .map(|m| m.len() > 100_000)
                    .unwrap_or(false);

                if !jar_valid && json_path.exists() {
                    if let Ok(content) = fs::read_to_string(&json_path) {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                            if let Some(inherits) = parsed["inheritsFrom"].as_str() {
                                if validate_version_id(inherits).is_ok() {
                                    let inh_jar1 = entry.path().join(format!("{}.jar", inherits));
                                    let inh_jar2 = versions_dir
                                        .join(inherits)
                                        .join(format!("{}.jar", inherits));
                                    jar_valid = fs::metadata(&inh_jar1)
                                        .map(|m| m.len() > 100_000)
                                        .unwrap_or(false)
                                        || fs::metadata(&inh_jar2)
                                            .map(|m| m.len() > 100_000)
                                            .unwrap_or(false);
                                }
                            }
                        }
                    }
                }

                if json_path.exists() && jar_valid {
                    installed.push(name);
                }
            }
        }
    }
    installed.sort_by(|left, right| {
        let (left_key, left_name) = version_sort_key(left);
        let (right_key, right_name) = version_sort_key(right);
        right_key
            .cmp(&left_key)
            .then_with(|| left_name.cmp(&right_name))
    });
    Ok(installed)
}

#[cfg(target_os = "windows")]
fn current_os_version() -> Option<String> {
    use windows_sys::Win32::System::SystemInformation::{GetVersionExW, OSVERSIONINFOW};
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    if unsafe { GetVersionExW(&mut info) } == 0 {
        return None;
    }
    Some(format!(
        "{}.{}.{}",
        info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
    ))
}

#[cfg(not(target_os = "windows"))]
fn current_os_version() -> Option<String> {
    None
}

fn os_version_pattern_matches(expected: &str, current: Option<&str>) -> bool {
    let expected = expected.trim();
    if expected.is_empty() || expected == "*" {
        return true;
    }
    let Some(current) = current else {
        return true;
    };
    expected.split('|').any(|pattern| {
        let pattern = pattern.trim();
        let starts = pattern.strip_prefix('^').unwrap_or(pattern);
        let ends = starts.strip_suffix('$').unwrap_or(starts);
        let normalized = ends.replace("\\.", ".");
        if normalized.contains('\\') || normalized.contains('[') || normalized.contains('(') {
            return current.contains(&normalized);
        }
        match (pattern.starts_with('^'), pattern.ends_with('$')) {
            (true, true) => current == normalized,
            (true, false) => current.starts_with(&normalized),
            (false, true) => current.ends_with(&normalized),
            (false, false) => current == normalized || current.starts_with(&normalized),
        }
    })
}

fn rule_applies(rule: &serde_json::Value) -> bool {
    if let Some(os) = rule.get("os") {
        let expected_os = os
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let current_os = if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "osx"
        } else {
            "linux"
        };
        if expected_os != current_os {
            return false;
        }
        if let Some(expected_version) = os.get("version").and_then(|value| value.as_str()) {
            let current_version = current_os_version();
            if !os_version_pattern_matches(expected_version, current_version.as_deref()) {
                return false;
            }
        }
        if let Some(expected_arch) = os.get("arch").and_then(|value| value.as_str()) {
            let current_arch = match std::env::consts::ARCH {
                "x86_64" => "x86_64",
                "x86" => "x86",
                "aarch64" => "arm64",
                other => other,
            };
            if expected_arch != current_arch {
                return false;
            }
        }
    }

    if let Some(features) = rule.get("features").and_then(|value| value.as_object()) {
        for (name, expected) in features {
            let actual = match name.as_str() {
                "is_demo_user" => false,
                "has_custom_resolution" => true,
                _ => false,
            };
            if expected.as_bool().unwrap_or(false) != actual {
                return false;
            }
        }
    }
    true
}

fn is_rule_allowed(rules: Option<&Vec<serde_json::Value>>) -> bool {
    let rules = match rules {
        Some(r) if !r.is_empty() => r,
        _ => return true,
    };
    let mut allowed = false;
    for rule in rules {
        if rule_applies(rule) {
            allowed = rule
                .get("action")
                .and_then(|value| value.as_str())
                .unwrap_or("allow")
                == "allow";
        }
    }
    allowed
}

fn is_native_for_current(classifier: &str) -> bool {
    let c = classifier.to_lowercase();
    if !c.starts_with("natives-") {
        return false;
    }
    let rest = &c["natives-".len()..];
    #[cfg(target_os = "windows")]
    const OS: &str = "windows";
    #[cfg(target_os = "macos")]
    const OS: &str = "macos";
    #[cfg(target_os = "linux")]
    const OS: &str = "linux";
    let os_ok = rest == OS
        || rest.starts_with(&format!("{}-", OS))
        || rest.starts_with(&format!("{}_", OS))
        || (OS == "macos" && (rest == "osx" || rest.starts_with("osx-")));
    if !os_ok {
        return false;
    }
    let arch = std::env::consts::ARCH;
    if rest.contains("arm64") || rest.contains("aarch64") {
        return arch == "aarch64";
    }
    if rest.contains("x64") || rest.contains("x86-64") || rest.contains("x86_64") {
        return arch == "x86_64";
    }
    if rest.contains("x86") || rest.contains("386") {
        return arch == "x86";
    }
    let tokens: Vec<&str> = rest.split(['-', '_']).collect();
    let has32 = tokens.contains(&"32");
    let has64 = tokens.contains(&"64");
    if has32 && !has64 {
        return arch == "x86";
    }
    if has64 && !has32 {
        return arch == "x86_64";
    }
    true
}

#[derive(Clone, Debug)]
struct LibraryDownload {
    url: String,
    dest: PathBuf,
    is_native: bool,
    sha1: Option<String>,
    size: Option<u64>,
}

fn has_legacy_native_metadata(json_val: &serde_json::Value) -> bool {
    json_val["libraries"]
        .as_array()
        .map(|libraries| {
            libraries.iter().any(|library| {
                library["natives"].is_object() && is_rule_allowed(library["rules"].as_array())
            })
        })
        .unwrap_or(false)
}

fn parse_libraries_from_json(
    json_val: &serde_json::Value,
    libraries_dir: &Path,
) -> Vec<LibraryDownload> {
    let mut downloads = Vec::new();
    if let Some(libs) = json_val["libraries"].as_array() {
        for lib in libs {
            let rules_opt = lib["rules"].as_array();
            if !is_rule_allowed(rules_opt) {
                continue;
            }

            let mut artifact_pushed = false;
            if let Some(artifact) = lib["downloads"]["artifact"].as_object() {
                if let (Some(url), Some(path)) =
                    (artifact["url"].as_str(), artifact["path"].as_str())
                {
                    if let Ok(relative) = safe_relative_path(path) {
                        let dest = libraries_dir.join(relative);
                        let sha1 = artifact
                            .get("sha1")
                            .and_then(|value| value.as_str())
                            .map(ToOwned::to_owned);
                        let size = artifact.get("size").and_then(|value| value.as_u64());
                        let classifier = lib["name"].as_str().and_then(|n| {
                            let p: Vec<&str> = n.split(':').collect();
                            if p.len() >= 4 {
                                Some(p[3].to_string())
                            } else {
                                None
                            }
                        });
                        if let Some(cl) = classifier {
                            if cl.starts_with("natives-") {
                                if is_native_for_current(&cl) {
                                    downloads.push(LibraryDownload {
                                        url: url.trim().to_string(),
                                        dest: dest.clone(),
                                        is_native: false,
                                        sha1: sha1.clone(),
                                        size,
                                    });
                                    artifact_pushed = true;
                                }
                            } else {
                                downloads.push(LibraryDownload {
                                    url: url.trim().to_string(),
                                    dest,
                                    is_native: false,
                                    sha1,
                                    size,
                                });
                                artifact_pushed = true;
                            }
                        } else {
                            downloads.push(LibraryDownload {
                                url: url.trim().to_string(),
                                dest,
                                is_native: false,
                                sha1,
                                size,
                            });
                            artifact_pushed = true;
                        }
                    }
                }
            }

            if let (Some(natives_map), Some(classifiers)) = (
                lib["natives"].as_object(),
                lib["downloads"]["classifiers"].as_object(),
            ) {
                #[cfg(target_os = "windows")]
                const OS_KEY: &str = "windows";
                #[cfg(target_os = "macos")]
                const OS_KEY: &str = "osx";
                #[cfg(target_os = "linux")]
                const OS_KEY: &str = "linux";
                if let Some(key_tpl) = natives_map.get(OS_KEY).and_then(|v| v.as_str()) {
                    let arch_num = if std::env::consts::ARCH == "x86_64" {
                        "64"
                    } else {
                        "32"
                    };
                    let key = key_tpl.replace("${arch}", arch_num);
                    if is_native_for_current(&key) {
                        if let Some(entry) = classifiers.get(&key) {
                            if let (Some(url), Some(p)) =
                                (entry["url"].as_str(), entry["path"].as_str())
                            {
                                let Ok(relative) = safe_relative_path(p) else {
                                    continue;
                                };
                                let dest = libraries_dir.join(relative);
                                downloads.push(LibraryDownload {
                                    url: url.trim().to_string(),
                                    dest,
                                    is_native: true,
                                    sha1: entry
                                        .get("sha1")
                                        .and_then(|value| value.as_str())
                                        .map(ToOwned::to_owned),
                                    size: entry.get("size").and_then(|value| value.as_u64()),
                                });
                                continue;
                            }
                        }
                    }
                }
            }

            if artifact_pushed {
                continue;
            }

            if let Some(name) = lib["name"].as_str() {
                let parts: Vec<&str> = name.split(':').collect();
                if parts.len() >= 3 {
                    if parts
                        .iter()
                        .any(|part| validate_safe_component(part, "Maven coordinate").is_err())
                    {
                        continue;
                    }
                    if parts.len() > 3
                        && parts[3].starts_with("natives-")
                        && !is_native_for_current(parts[3])
                    {
                        continue;
                    }
                    let native = parts.len() > 3 && is_native_for_current(parts[3]);
                    let group = parts[0].replace('.', "/");
                    let artifact = parts[1];
                    let version = parts[2];
                    let file_name = if parts.len() > 3 {
                        format!("{}-{}-{}.jar", artifact, version, parts[3])
                    } else {
                        format!("{}-{}.jar", artifact, version)
                    };
                    let rel_path = format!("{}/{}/{}/{}", group, artifact, version, file_name);
                    let base_url = lib["url"]
                        .as_str()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("https://maven.fabricmc.net/");
                    let trimmed_base = base_url.trim_end_matches('/');
                    let url = format!("{}/{}", trimmed_base, rel_path.trim_start_matches('/'));
                    let dest =
                        libraries_dir.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                    downloads.push(LibraryDownload {
                        url,
                        dest,
                        is_native: native,
                        sha1: None,
                        size: None,
                    });
                }
            }
        }
    }
    downloads
}

async fn download_libraries_parallel(items: Vec<LibraryDownload>) -> Result<(), String> {
    for item in &items {
        if item.url.trim().is_empty() {
            let metadata = fs::symlink_metadata(&item.dest).map_err(|error| {
                format!(
                    "Required local library is missing: {} ({error})",
                    item.dest.display()
                )
            })?;
            if is_link_metadata(&metadata) || !metadata.is_file() || metadata.len() == 0 {
                return Err(format!(
                    "Required local library is missing or invalid: {}",
                    item.dest.display()
                ));
            }
            if let Some(expected_size) = item.size {
                if metadata.len() != expected_size {
                    return Err(format!(
                        "Local library size mismatch for {}: expected {}, got {}",
                        item.dest.display(),
                        expected_size,
                        metadata.len()
                    ));
                }
            }
            if let Some(expected_sha1) = item.sha1.as_deref() {
                verify_sha1(&item.dest, expected_sha1)?;
            }
            continue;
        }

        validate_url(&item.url)
            .map_err(|error| format!("Invalid library URL for {}: {error}", item.dest.display()))?;
    }

    let missing: Vec<LibraryDownload> = items
        .into_iter()
        .filter(|item| {
            if item.url.trim().is_empty() {
                return false;
            }
            let metadata = fs::metadata(&item.dest).ok();
            if metadata
                .as_ref()
                .map(|value| value.len() == 0)
                .unwrap_or(true)
            {
                return true;
            }
            if let Some(expected_size) = item.size {
                if metadata
                    .as_ref()
                    .map(|value| value.len() != expected_size)
                    .unwrap_or(true)
                {
                    return true;
                }
            }
            item.sha1
                .as_deref()
                .map(|expected| verify_sha1(&item.dest, expected).is_err())
                .unwrap_or(false)
        })
        .collect();

    if missing.is_empty() {
        return Ok(());
    }
    let expected_downloads = missing.len();

    for item in &missing {
        if let Some(parent) = item.dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create library directory: {}", error))?;
        }
    }

    use std::sync::{Arc, Mutex};
    let results: Arc<Mutex<Vec<Result<PathBuf, String>>>> = Arc::new(Mutex::new(Vec::new()));
    let queue = Arc::new(Mutex::new(missing));
    let mut handles = Vec::new();

    for _ in 0..8 {
        let queue = Arc::clone(&queue);
        let results = Arc::clone(&results);
        handles.push(tokio::spawn(async move {
            loop {
                let item = {
                    let mut queue = queue.lock().unwrap_or_else(|error| error.into_inner());
                    queue.pop()
                };
                let Some(item) = item else {
                    break;
                };
                let mut last_error = "download failed".to_string();
                let mut success = false;
                for attempt in 0..2 {
                    match download_file_http(&item.url, &item.dest).await {
                        Ok(()) => {
                            let size_ok = fs::metadata(&item.dest)
                                .map(|metadata| {
                                    item.size
                                        .map(|expected| metadata.len() == expected)
                                        .unwrap_or(true)
                                })
                                .unwrap_or(false);
                            let hash_ok = item
                                .sha1
                                .as_deref()
                                .map(|expected| verify_sha1(&item.dest, expected).is_ok())
                                .unwrap_or(true);
                            if size_ok && hash_ok {
                                success = true;
                                break;
                            }
                            last_error = "library size/checksum mismatch".into();
                            let _ = fs::remove_file(&item.dest);
                        }
                        Err(error) => last_error = error,
                    }
                    if attempt == 0 {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                }
                let mut results = results.lock().unwrap_or_else(|error| error.into_inner());
                if success {
                    results.push(Ok(item.dest));
                } else {
                    results.push(Err(format!("{}: {}", item.dest.display(), last_error)));
                }
            }
        }));
    }

    let mut worker_panicked = false;
    for handle in handles {
        if handle.await.is_err() {
            worker_panicked = true;
        }
    }

    let results = results.lock().unwrap_or_else(|error| error.into_inner());
    if worker_panicked || results.len() != expected_downloads {
        return Err(format!(
            "Не удалось скачать все библиотеки (ожидалось {}, обработано {})",
            expected_downloads,
            results.len()
        ));
    }
    let failed: Vec<String> = results
        .iter()
        .filter_map(|result| result.as_ref().err().cloned())
        .collect();
    if !failed.is_empty() {
        return Err(format!(
            "Не скачались библиотеки ({}), первые: {}",
            failed.len(),
            failed
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }
    Ok(())
}

#[tauri::command]
async fn download_version(
    app: tauri::AppHandle,
    version_name: String,
    package_url: Option<String>,
    client_url: Option<String>,
    vanilla_package_url: Option<String>,
    expected_size: Option<u64>,
) -> Result<String, String> {
    validate_version_id(&version_name)?;
    let mc_dir = get_minecraft_dir();
    let versions_dir = mc_dir.join("versions");
    let version_dir = versions_dir.join(&version_name);
    let libraries_dir = mc_dir.join("libraries");
    let assets_dir = mc_dir.join("assets").join("indexes");

    fs::create_dir_all(&version_dir).map_err(|e| {
        format!(
            "Failed to create directory {}: {}",
            version_dir.display(),
            e
        )
    })?;
    fs::create_dir_all(&libraries_dir)
        .map_err(|e| format!("Failed to create libraries directory: {}", e))?;
    fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Failed to create assets directory: {}", e))?;

    let json_file = version_dir.join(format!("{}.json", version_name));
    let mut jar_file = version_dir.join(format!("{}.jar", version_name));

    if json_file.exists() {
        if let Ok(content) = fs::read_to_string(&json_file) {
            let stale_loader = content.contains("fabric-loader")
                && (content.contains("net.fabricmc:fabric-loader:0.16.")
                    || content.contains("net.fabricmc:fabric-loader:0.17.")
                    || content.contains("net.fabricmc:fabric-loader:0.18."));
            if stale_loader && package_url.is_some() {
                eprintln!(
                    "[download] stale fabric profile detected for {}, refetching",
                    version_name
                );
                let _ = fs::remove_file(&json_file);
            }
        }
    }

    if json_file.exists() {
        if let Ok(content) = fs::read_to_string(&json_file) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(inherits) = parsed["inheritsFrom"].as_str() {
                    let parent_dir = version_directory(&mc_dir, inherits)?;
                    fs::create_dir_all(&parent_dir)
                        .map_err(|e| format!("Failed to create parent version directory: {}", e))?;
                    jar_file = parent_dir.join(format!("{}.jar", inherits));
                }
            }
        }
    }

    if let Some(ref url) = package_url {
        if !json_file.exists() {
            validate_version_metadata_url(url, true)?;

            let _ = app.emit(
                "download-progress",
                ProgressPayload {
                    version: version_name.clone(),
                    percent: 3,
                    current: 0,
                    total: 0,
                    stage: "Манифест...".into(),
                },
            );

            download_file_http(url, &json_file).await?;
        }
    }

    {
        let lower = version_name.to_lowercase();
        if lower.contains("forge") || lower.contains("neoforge") {
            return Err(
                "Forge/NeoForge устанавливаются через отдельную проверенную installer-команду"
                    .into(),
            );
        }
    }

    if let Ok(content) = fs::read_to_string(&json_file) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(inherits) = parsed["inheritsFrom"].as_str() {
                let parent_dir = version_directory(&mc_dir, inherits)?;
                fs::create_dir_all(&parent_dir)
                    .map_err(|e| format!("Failed to create parent version directory: {}", e))?;
                jar_file = parent_dir.join(format!("{}.jar", inherits));
            }
        }
    }

    let requested_client_url = client_url;
    let requested_client_size = expected_size.unwrap_or(0);
    let mut jar_download_url: Option<String> = None;
    let mut client_sha1: Option<String> = None;
    let mut total_bytes = 0u64;
    let mut all_libraries: Vec<LibraryDownload> = Vec::new();
    let mut asset_index_url: Option<String> = None;
    let mut asset_index_id: Option<String> = None;
    let mut asset_index_sha1: Option<String> = None;

    if json_file.exists() {
        if let Ok(content) = fs::read_to_string(&json_file) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                if jar_download_url.is_none() {
                    if let Some(u) = parsed["downloads"]["client"]["url"].as_str() {
                        jar_download_url = Some(u.to_string());
                    }
                }
                if total_bytes == 0 {
                    if let Some(s) = parsed["downloads"]["client"]["size"].as_u64() {
                        total_bytes = s;
                    }
                }
                if let Some(hash) = parsed["downloads"]["client"]["sha1"].as_str() {
                    client_sha1 = Some(normalize_sha1(hash)?);
                }
                all_libraries.extend(parse_libraries_from_json(&parsed, &libraries_dir));

                if let Some(ai) = parsed["assetIndex"].as_object() {
                    if let (Some(u), Some(id)) = (ai["url"].as_str(), ai["id"].as_str()) {
                        asset_index_url = Some(u.to_string());
                        asset_index_id = Some(id.to_string());
                        if let Some(hash) = ai["sha1"].as_str() {
                            asset_index_sha1 = Some(normalize_sha1(hash)?);
                        }
                    }
                }
            }
        }
    }

    let mut vanilla_json_parsed: Option<serde_json::Value> = None;
    if let Some(ref v_url) = vanilla_package_url {
        validate_version_metadata_url(v_url, false)?;

        let parent_id = fs::read_to_string(&json_file)
            .ok()
            .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
            .and_then(|parsed| {
                parsed["inheritsFrom"]
                    .as_str()
                    .map(|value| value.to_string())
            });
        if let Some(value) = parent_id.as_deref() {
            validate_version_id(value)?;
        }

        let vanilla_json_path = if let Some(ref pid) = parent_id {
            let parent_dir = version_directory(&mc_dir, pid)?;
            fs::create_dir_all(&parent_dir)
                .map_err(|e| format!("Failed to create parent version directory: {}", e))?;
            parent_dir.join(format!("{}.json", pid))
        } else {
            version_dir.join("vanilla.json")
        };

        if !vanilla_json_path.exists() {
            let first_error = download_file_http(v_url, &vanilla_json_path).await.err();
            if let Some(first_error) = first_error {
                tokio::time::sleep(Duration::from_millis(500)).await;
                download_file_http(v_url, &vanilla_json_path)
                    .await
                    .map_err(|retry_error| {
                        format!(
                            "Не удалось скачать описание версии {}: {}. Повторная попытка: {}",
                            version_name, first_error, retry_error
                        )
                    })?;
            }
        }

        if let Ok(v_content) = fs::read_to_string(&vanilla_json_path) {
            if let Ok(v_parsed) = serde_json::from_str::<serde_json::Value>(&v_content) {
                vanilla_json_parsed = Some(v_parsed);
            }
        }
    } else if json_file.exists() {
        if let Ok(content) = fs::read_to_string(&json_file) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(inherits) = parsed["inheritsFrom"].as_str() {
                    let inh_json = versions_dir
                        .join(inherits)
                        .join(format!("{}.json", inherits));
                    if inh_json.exists() {
                        if let Ok(inh_content) = fs::read_to_string(&inh_json) {
                            if let Ok(inh_parsed) =
                                serde_json::from_str::<serde_json::Value>(&inh_content)
                            {
                                vanilla_json_parsed = Some(inh_parsed);
                            }
                        }
                    }
                }
            }
        }
    }

    if let Some(ref v_parsed) = vanilla_json_parsed {
        if jar_download_url.is_none() {
            if let Some(u) = v_parsed["downloads"]["client"]["url"].as_str() {
                jar_download_url = Some(u.to_string());
            }
        }
        if let Some(hash) = v_parsed["downloads"]["client"]["sha1"].as_str() {
            client_sha1 = Some(normalize_sha1(hash)?);
        }
        if total_bytes == 0 {
            if let Some(s) = v_parsed["downloads"]["client"]["size"].as_u64() {
                total_bytes = s;
            }
        }
        all_libraries.extend(parse_libraries_from_json(v_parsed, &libraries_dir));

        if asset_index_url.is_none() {
            if let Some(ai) = v_parsed["assetIndex"].as_object() {
                if let (Some(u), Some(id)) = (ai["url"].as_str(), ai["id"].as_str()) {
                    asset_index_url = Some(u.to_string());
                    asset_index_id = Some(id.to_string());
                    if let Some(hash) = ai["sha1"].as_str() {
                        asset_index_sha1 = Some(normalize_sha1(hash)?);
                    }
                }
            }
        }
    }

    if let Some(requested_url) = requested_client_url.as_deref() {
        let resolved_url = jar_download_url
            .as_deref()
            .ok_or_else(|| "Version metadata does not contain a client download URL".to_string())?;
        if requested_url != resolved_url {
            return Err("Client URL does not match the signed version metadata".into());
        }
    }
    if requested_client_size > 0 && total_bytes > 0 && requested_client_size != total_bytes {
        return Err("Client size does not match the signed version metadata".into());
    }
    if total_bytes == 0 {
        total_bytes = requested_client_size;
    }
    if client_sha1.is_none() {
        return Err("Version metadata does not contain a client SHA-1".into());
    }

    if version_name.contains("26.") {
        for item in &mut all_libraries {
            let s = item.dest.to_string_lossy().replace('\\', "/");
            if s.contains("org/ow2/asm") && s.contains("9.7.1") {
                let new_path = s.replace("9.7.1", "9.10.1");
                item.dest = PathBuf::from(new_path);
                item.url = item
                    .url
                    .replace("9.7.1", "9.10.1")
                    .replace("maven.fabricmc.net", "repo1.maven.org/maven2");
                item.sha1 = None;
                item.size = None;
            }
        }
    }

    let url = match jar_download_url {
        Some(u) => u,
        None => {
            return Err(format!(
                "Не удалось найти URL client.jar для версии {}",
                version_name
            ))
        }
    };

    validate_url(&url)?;

    let mut already_downloaded = false;
    if let Ok(meta) = fs::metadata(&jar_file) {
        let size_ok = (total_bytes > 0 && meta.len() == total_bytes)
            || (total_bytes == 0 && meta.len() > 1_000_000);
        if size_ok {
            if let Some(expected_hash) = client_sha1.as_deref() {
                match verify_sha1(&jar_file, expected_hash) {
                    Ok(()) => already_downloaded = true,
                    Err(error) => {
                        eprintln!("[download] removing corrupt client jar: {}", error);
                        fs::remove_file(&jar_file)
                            .map_err(|e| format!("Failed to remove corrupt client jar: {}", e))?;
                    }
                }
            } else {
                already_downloaded = true;
            }
        } else {
            fs::remove_file(&jar_file)
                .map_err(|e| format!("Failed to remove client jar with unexpected size: {}", e))?;
        }
    }

    if !already_downloaded {
        let _ = app.emit(
            "download-progress",
            ProgressPayload {
                version: version_name.clone(),
                percent: 10,
                current: 0,
                total: total_bytes,
                stage: "Клиент игры...".into(),
            },
        );

        let app_clone = app.clone();
        let version_clone = version_name.clone();
        download_file_with_progress(&url, &jar_file, total_bytes, move |current, total| {
            let percent = if total > 0 {
                10 + (((current as f64 / total as f64) * 60.0) as u32)
            } else {
                40
            };
            let _ = app_clone.emit(
                "download-progress",
                ProgressPayload {
                    version: version_clone.clone(),
                    percent: percent.min(70),
                    current,
                    total,
                    stage: "Клиент игры...".into(),
                },
            );
        })
        .await?;
    }

    if let Some(expected_hash) = client_sha1.as_deref() {
        verify_sha1(&jar_file, expected_hash)?;
    }

    let final_size = fs::metadata(&jar_file).map(|m| m.len()).unwrap_or(0);
    if final_size < 100_000 {
        return Err(format!(
            "Ошибка: файл client.jar повреждён или пуст ({})",
            jar_file.display()
        ));
    }

    if !all_libraries.is_empty() {
        let _ = app.emit(
            "download-progress",
            ProgressPayload {
                version: version_name.clone(),
                percent: 75,
                current: final_size,
                total: total_bytes,
                stage: "Библиотеки...".into(),
            },
        );

        download_libraries_parallel(all_libraries).await?;
    }

    if let (Some(ai_url), Some(ai_id)) = (asset_index_url, asset_index_id) {
        validate_url(&ai_url)?;

        validate_safe_component(&ai_id, "asset index id")?;
        let ai_path = assets_dir.join(format!("{}.json", ai_id));
        if !ai_path.exists() {
            let _ = app.emit(
                "download-progress",
                ProgressPayload {
                    version: version_name.clone(),
                    percent: 80,
                    current: final_size,
                    total: total_bytes,
                    stage: "Индекс ресурсов...".into(),
                },
            );

            download_file_http_limited(&ai_url, &ai_path, 50 * 1024 * 1024).await?;
        }
        if let Some(expected_hash) = asset_index_sha1.as_deref() {
            verify_sha1(&ai_path, expected_hash)?;
        }

        if ai_path.exists() {
            if let Ok(ai_content) = fs::read_to_string(&ai_path) {
                if let Ok(ai_parsed) = serde_json::from_str::<serde_json::Value>(&ai_content) {
                    if let Some(objects) = ai_parsed["objects"].as_object() {
                        let objects_dir = mc_dir.join("assets").join("objects");
                        let _ = fs::create_dir_all(&objects_dir);

                        let mut asset_downloads: Vec<(String, PathBuf)> = Vec::new();
                        for (_name, obj) in objects {
                            if let Some(hash) = obj["hash"].as_str() {
                                if hash.len() != 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit())
                                {
                                    return Err(format!("Некорректный SHA-1 ресурса: {}", hash));
                                }
                                let prefix = &hash[..2];
                                let dest = objects_dir.join(prefix).join(hash);
                                if !dest.exists() {
                                    let url = format!(
                                        "https://resources.download.minecraft.net/{}/{}",
                                        prefix, hash
                                    );
                                    asset_downloads.push((url, dest));
                                }
                            }
                        }

                        if !asset_downloads.is_empty() {
                            let total_assets = asset_downloads.len();
                            let _ = app.emit(
                                "download-progress",
                                ProgressPayload {
                                    version: version_name.clone(),
                                    percent: 82,
                                    current: 0,
                                    total: total_assets as u64,
                                    stage: format!("Ресурсы (0/{})...", total_assets),
                                },
                            );

                            use futures_util::{stream, StreamExt};
                            let downloaded_count =
                                std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
                            let failures =
                                std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
                            let results = stream::iter(asset_downloads)
                                .map(|(url, dest)| {
                                    let downloaded_count = std::sync::Arc::clone(&downloaded_count);
                                    let failures = std::sync::Arc::clone(&failures);
                                    async move {
                                        match download_file_http_limited(
                                            &url,
                                            &dest,
                                            50 * 1024 * 1024,
                                        )
                                        .await
                                        {
                                            Ok(_) => {
                                                let verification = dest
                                                    .file_name()
                                                    .and_then(|name| name.to_str())
                                                    .ok_or_else(|| {
                                                        "Asset path has no file name".to_string()
                                                    })
                                                    .and_then(|hash| verify_sha1(&dest, hash));
                                                if let Err(error) = verification {
                                                    let _ = fs::remove_file(&dest);
                                                    failures
                                                        .lock()
                                                        .unwrap_or_else(|e| e.into_inner())
                                                        .push(error);
                                                } else {
                                                    downloaded_count.fetch_add(
                                                        1,
                                                        std::sync::atomic::Ordering::Relaxed,
                                                    );
                                                }
                                            }
                                            Err(error) => {
                                                failures
                                                    .lock()
                                                    .unwrap_or_else(|e| e.into_inner())
                                                    .push(error);
                                            }
                                        }
                                    }
                                })
                                .buffer_unordered(8)
                                .collect::<Vec<_>>()
                                .await;
                            let _ = results;

                            let failures = failures.lock().unwrap_or_else(|e| e.into_inner());
                            if !failures.is_empty() {
                                return Err(format!(
                                    "Не удалось скачать {} ресурсов: {}",
                                    failures.len(),
                                    failures
                                        .iter()
                                        .take(3)
                                        .cloned()
                                        .collect::<Vec<_>>()
                                        .join("; ")
                                ));
                            }
                            let _ = app.emit(
                                "download-progress",
                                ProgressPayload {
                                    version: version_name.clone(),
                                    percent: 98,
                                    current: total_assets as u64,
                                    total: total_assets as u64,
                                    stage: "Ресурсы готовы".into(),
                                },
                            );
                        }
                    }
                }
            }
        }
    }

    if let Some(ref v_parsed) = vanilla_json_parsed {
        if let Some(logging_file) = v_parsed["logging"]["client"]["file"].as_object() {
            let log_url = logging_file
                .get("url")
                .and_then(|value| value.as_str())
                .ok_or("Version metadata is missing the client logging URL")?;
            let log_id = logging_file
                .get("id")
                .and_then(|value| value.as_str())
                .ok_or("Version metadata is missing the client logging id")?;
            let log_sha1 = logging_file
                .get("sha1")
                .and_then(|value| value.as_str())
                .ok_or("Version metadata is missing the client logging SHA-1")?;
            let expected_sha1 = normalize_sha1(log_sha1)?;
            validate_url(log_url)?;
            validate_safe_component(log_id, "logging id")?;

            let log_dir = mc_dir.join("assets").join("log_configs");
            let _ = fs::create_dir_all(&log_dir);
            let log_path = log_dir.join(log_id);
            if !log_path.is_file() {
                download_file_http_limited(log_url, &log_path, 10 * 1024 * 1024).await?;
            }
            verify_sha1(&log_path, &expected_sha1)?;
        }
    }

    let _ = app.emit(
        "download-progress",
        ProgressPayload {
            version: version_name.clone(),
            percent: 100,
            current: final_size,
            total: if total_bytes > 0 {
                total_bytes
            } else {
                final_size
            },
            stage: "Готово!".into(),
        },
    );

    Ok(version_name)
}

#[tauri::command]
async fn get_forge_promotions() -> Result<String, String> {
    fetch_text_limited(forge::FORGE_PROMOTIONS_URL, 2 * 1024 * 1024).await
}

#[tauri::command]
async fn get_forge_versions() -> Result<String, String> {
    fetch_text_limited(forge::FORGE_METADATA_URL, 4 * 1024 * 1024).await
}

fn parse_maven_metadata_versions(xml: &str) -> Vec<String> {
    xml.split("<version>")
        .skip(1)
        .filter_map(|chunk| chunk.split("</version>").next())
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 160
                && value.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '+' | '-')
                })
        })
        .map(ToOwned::to_owned)
        .collect()
}

#[tauri::command]
async fn get_neoforge_versions() -> Result<String, String> {
    let metadata = fetch_text_limited(forge::NEOFORGE_VERSIONS_URL, 4 * 1024 * 1024).await?;
    let versions = parse_maven_metadata_versions(&metadata);
    if versions.is_empty() {
        return Err("NeoForge metadata does not contain any versions".into());
    }
    serde_json::to_string(&versions).map_err(|error| error.to_string())
}

#[tauri::command]
async fn install_forge(
    app: tauri::AppHandle,
    minecraft_version: String,
    forge_version: Option<String>,
) -> Result<ForgeInstallResult, String> {
    forge::validate_minecraft_version(&minecraft_version).map_err(|error| error.to_string())?;
    let build = if let Some(version) = forge_version.as_deref() {
        ForgeBuild::new(&minecraft_version, version, ForgeChannel::Explicit)
            .map_err(|error| error.to_string())?
    } else {
        let promotions = fetch_text_limited(forge::FORGE_PROMOTIONS_URL, 2 * 1024 * 1024).await?;
        forge::resolve_installable_forge_build(&promotions, &minecraft_version)
            .map_err(|error| error.to_string())?
    };
    build
        .ensure_headless_client_install_supported()
        .map_err(|error| error.to_string())?;
    let _install_guard = acquire_forge_install(&build.profile_id)?;
    let _shared_process_lock = acquire_shared_content_process_lock()?;

    let mc_dir = get_minecraft_dir();
    fs::create_dir_all(&mc_dir).map_err(|error| error.to_string())?;
    let versions_dir = mc_dir.join("versions");

    let parent_json = version_json_path(&mc_dir, &minecraft_version)?;
    let parent_jar = versions_dir
        .join(&minecraft_version)
        .join(format!("{}.jar", minecraft_version));
    let parent_ready = parent_json.is_file()
        && fs::metadata(&parent_jar)
            .map(|metadata| metadata.len() > 100_000)
            .unwrap_or(false);
    if !parent_ready {
        let manifest_text = fetch_text_limited(
            "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
            10 * 1024 * 1024,
        )
        .await?;
        let manifest: serde_json::Value = serde_json::from_str(&manifest_text)
            .map_err(|error| format!("Некорректный Mojang manifest: {}", error))?;
        let version_entry = manifest["versions"]
            .as_array()
            .and_then(|versions| {
                versions.iter().find(|entry| {
                    entry["id"].as_str() == Some(minecraft_version.as_str())
                        && entry["type"].as_str() == Some("release")
                })
            })
            .ok_or_else(|| {
                format!(
                    "Minecraft {} не найден среди официальных релизов",
                    minecraft_version
                )
            })?;
        let package_url = version_entry["url"]
            .as_str()
            .ok_or_else(|| "В Mojang manifest отсутствует URL версии".to_string())?;
        download_version(
            app.clone(),
            minecraft_version.clone(),
            Some(package_url.to_string()),
            None,
            None,
            None,
        )
        .await?;
    }

    let launcher_profiles = mc_dir.join("launcher_profiles.json");
    let microsoft_profiles = mc_dir.join("launcher_profiles_microsoft_store.json");
    if !launcher_profiles.exists() && !microsoft_profiles.exists() {
        fs::write(&launcher_profiles, "{\n  \"profiles\": {}\n}\n")
            .map_err(|error| format!("Failed to create launcher_profiles.json: {}", error))?;
    }

    let cache_dir = mc_dir.join("canger").join("cache").join("forge");
    fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let installer_name =
        forge::forge_installer_filename(&build.minecraft_version, &build.forge_version)
            .map_err(|error| error.to_string())?;
    let installer_path = cache_dir.join(&installer_name);
    let sidecar = fetch_text_limited(&build.installer_sha1_url, 4 * 1024).await?;
    let expected_sha1 = forge::validate_installer_sha1_sidecar(&sidecar, Some(&installer_name))
        .map_err(|error| error.to_string())?;

    let cached_valid =
        installer_path.is_file() && verify_sha1(&installer_path, &expected_sha1).is_ok();
    if !cached_valid {
        let _ = fs::remove_file(&installer_path);
        let _ = app.emit(
            "download-progress",
            ProgressPayload {
                version: build.profile_id.clone(),
                percent: 8,
                current: 0,
                total: 0,
                stage: "Загрузка официального Forge installer...".into(),
            },
        );
        download_file_http_limited(&build.installer_url, &installer_path, 100 * 1024 * 1024)
            .await?;
        verify_sha1(&installer_path, &expected_sha1)?;
    }

    let mut magic = [0u8; 4];
    {
        use std::io::Read;
        let mut file = fs::File::open(&installer_path)
            .map_err(|error| format!("Failed to open Forge installer: {}", error))?;
        file.read_exact(&mut magic)
            .map_err(|error| format!("Forge installer is truncated: {}", error))?;
    }
    if &magic != b"PK\x03\x04" && &magic != b"PK\x05\x06" && &magic != b"PK\x07\x08" {
        let _ = fs::remove_file(&installer_path);
        return Err("Forge installer не является JAR/ZIP".into());
    }

    let required_major = get_required_java_version(&minecraft_version, &mc_dir)?;
    let java_path = match find_existing_java(&mc_dir, required_major) {
        Some(path) => path,
        None => auto_download_java(&app, &mc_dir, required_major).await?,
    };
    let console_java = if java_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("javaw.exe"))
        .unwrap_or(false)
    {
        let candidate = java_path.with_file_name("java.exe");
        if candidate.exists() {
            candidate
        } else if cfg!(windows) {
            java_path.with_file_name("java.exe")
        } else {
            java_path
        }
    } else {
        java_path
    };

    let _ = app.emit(
        "download-progress",
        ProgressPayload {
            version: build.profile_id.clone(),
            percent: 72,
            current: 0,
            total: 0,
            stage: "Установка Forge...".into(),
        },
    );
    let installer_log = cache_dir.join(format!("{}.log", build.profile_id));
    let mut command = tokio::process::Command::new(&console_java);
    command
        .arg("-jar")
        .arg(&installer_path)
        .arg("--installClient")
        .arg(&mc_dir)
        .current_dir(&mc_dir)
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(30 * 60), command.output())
        .await
        .map_err(|_| "Forge installer не ответил за 30 минут и был остановлен".to_string())?
        .map_err(|error| format!("Failed to run Forge installer: {}", error))?;
    let combined_log = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let _ = fs::write(&installer_log, &combined_log);
    if !output.status.success() {
        let tail = combined_log
            .lines()
            .rev()
            .take(12)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!(
            "Forge installer завершился с кодом {:?}:\n{}",
            output.status.code(),
            tail
        ));
    }

    let result =
        forge::validate_forge_profile(&versions_dir, &build).map_err(|error| error.to_string())?;
    let _ = app.emit(
        "download-progress",
        ProgressPayload {
            version: build.profile_id.clone(),
            percent: 100,
            current: 1,
            total: 1,
            stage: "Forge установлен".into(),
        },
    );
    Ok(result)
}

#[tauri::command]
async fn install_neoforge(
    app: tauri::AppHandle,
    minecraft_version: String,
    neoforge_version: String,
) -> Result<NeoForgeInstallResult, String> {
    let build = NeoForgeBuild::new(&minecraft_version, &neoforge_version)
        .map_err(|error| error.to_string())?;
    let _install_guard = acquire_forge_install(&build.profile_id)?;
    let _shared_process_lock = acquire_shared_content_process_lock()?;

    let mc_dir = get_minecraft_dir();
    fs::create_dir_all(&mc_dir).map_err(|error| error.to_string())?;
    let versions_dir = mc_dir.join("versions");

    let parent_json = version_json_path(&mc_dir, &minecraft_version)?;
    let parent_jar = versions_dir
        .join(&minecraft_version)
        .join(format!("{}.jar", minecraft_version));
    let parent_ready = parent_json.is_file()
        && fs::metadata(&parent_jar)
            .map(|metadata| metadata.len() > 100_000)
            .unwrap_or(false);
    if !parent_ready {
        let manifest_text = fetch_text_limited(
            "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
            10 * 1024 * 1024,
        )
        .await?;
        let manifest: serde_json::Value = serde_json::from_str(&manifest_text)
            .map_err(|error| format!("Некорректный Mojang manifest: {}", error))?;
        let version_entry = manifest["versions"]
            .as_array()
            .and_then(|versions| {
                versions.iter().find(|entry| {
                    entry["id"].as_str() == Some(minecraft_version.as_str())
                        && entry["type"].as_str() == Some("release")
                })
            })
            .ok_or_else(|| {
                format!(
                    "Minecraft {} не найден среди официальных релизов",
                    minecraft_version
                )
            })?;
        let package_url = version_entry["url"]
            .as_str()
            .ok_or_else(|| "В Mojang manifest отсутствует URL версии".to_string())?;
        download_version(
            app.clone(),
            minecraft_version.clone(),
            Some(package_url.to_string()),
            None,
            None,
            None,
        )
        .await?;
    }

    let launcher_profiles = mc_dir.join("launcher_profiles.json");
    let microsoft_profiles = mc_dir.join("launcher_profiles_microsoft_store.json");
    if !launcher_profiles.exists() && !microsoft_profiles.exists() {
        fs::write(&launcher_profiles, "{\n  \"profiles\": {}\n}\n")
            .map_err(|error| format!("Failed to create launcher_profiles.json: {}", error))?;
    }

    let cache_dir = mc_dir.join("canger").join("cache").join("neoforge");
    fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let installer_name = forge::neoforge_installer_filename(&build.neoforge_version)
        .map_err(|error| error.to_string())?;
    let installer_path = cache_dir.join(&installer_name);
    let sidecar = fetch_text_limited(&build.installer_sha256_url, 4 * 1024).await?;
    let expected_sha256 = forge::validate_installer_sha256_sidecar(&sidecar, Some(&installer_name))
        .map_err(|error| error.to_string())?;

    let cached_valid =
        installer_path.is_file() && verify_sha256(&installer_path, &expected_sha256).is_ok();
    if !cached_valid {
        let _ = fs::remove_file(&installer_path);
        let _ = app.emit(
            "download-progress",
            ProgressPayload {
                version: build.profile_id.clone(),
                percent: 8,
                current: 0,
                total: 0,
                stage: "Загрузка официального NeoForge installer...".into(),
            },
        );
        download_file_http_limited(&build.installer_url, &installer_path, 100 * 1024 * 1024)
            .await?;
        verify_sha256(&installer_path, &expected_sha256)?;
    }

    let mut magic = [0u8; 4];
    {
        use std::io::Read;
        let mut file = fs::File::open(&installer_path)
            .map_err(|error| format!("Failed to open NeoForge installer: {}", error))?;
        file.read_exact(&mut magic)
            .map_err(|error| format!("NeoForge installer is truncated: {}", error))?;
    }
    if &magic != b"PK\x03\x04" && &magic != b"PK\x05\x06" && &magic != b"PK\x07\x08" {
        let _ = fs::remove_file(&installer_path);
        return Err("NeoForge installer не является JAR/ZIP".into());
    }

    let required_major = get_required_java_version(&minecraft_version, &mc_dir)?;
    let java_path = match find_existing_java(&mc_dir, required_major) {
        Some(path) => path,
        None => auto_download_java(&app, &mc_dir, required_major).await?,
    };
    let console_java = if java_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("javaw.exe"))
        .unwrap_or(false)
    {
        let candidate = java_path.with_file_name("java.exe");
        if candidate.exists() {
            candidate
        } else if cfg!(windows) {
            java_path.with_file_name("java.exe")
        } else {
            java_path
        }
    } else {
        java_path
    };

    let _ = app.emit(
        "download-progress",
        ProgressPayload {
            version: build.profile_id.clone(),
            percent: 72,
            current: 0,
            total: 0,
            stage: "Установка NeoForge...".into(),
        },
    );
    let installer_log = cache_dir.join(format!("{}.log", build.profile_id));
    let mut command = tokio::process::Command::new(&console_java);
    command
        .arg("-jar")
        .arg(&installer_path)
        .arg("--installClient")
        .arg(&mc_dir)
        .current_dir(&mc_dir)
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(30 * 60), command.output())
        .await
        .map_err(|_| "NeoForge installer не ответил за 30 минут и был остановлен".to_string())?
        .map_err(|error| format!("Failed to run NeoForge installer: {}", error))?;
    let combined_log = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let _ = fs::write(&installer_log, &combined_log);
    if !output.status.success() {
        let tail = combined_log
            .lines()
            .rev()
            .take(12)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!(
            "NeoForge installer завершился с кодом {:?}:\n{}",
            output.status.code(),
            tail
        ));
    }

    let result = forge::validate_neoforge_profile(&versions_dir, &build)
        .map_err(|error| error.to_string())?;
    let _ = app.emit(
        "download-progress",
        ProgressPayload {
            version: build.profile_id.clone(),
            percent: 100,
            current: 1,
            total: 1,
            stage: "NeoForge установлен".into(),
        },
    );
    Ok(result)
}

fn check_java_version(java_exe: &Path) -> Option<u32> {
    let probe = {
        let name = java_exe.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.eq_ignore_ascii_case("javaw.exe") {
            let alt = java_exe.with_file_name("java.exe");
            if is_safe_regular_file(&alt) {
                alt
            } else {
                java_exe.to_path_buf()
            }
        } else {
            java_exe.to_path_buf()
        }
    };
    if !is_safe_regular_file(&probe) {
        return None;
    }
    let output = Command::new(&probe).arg("-version").output().ok()?;
    let text = String::from_utf8_lossy(&output.stderr);
    for line in text.lines() {
        if line.contains("version \"") {
            if let Some(start) = line.find("version \"") {
                let rest = &line[start + 9..];
                if let Some(end) = rest.find('\"') {
                    let ver = &rest[..end];
                    if ver.starts_with("1.") {
                        let parts: Vec<&str> = ver.split('.').collect();
                        if parts.len() > 1 {
                            return parts[1].parse::<u32>().ok();
                        }
                    } else {
                        let parts: Vec<&str> = ver.split('.').collect();
                        if !parts.is_empty() {
                            return parts[0].parse::<u32>().ok();
                        }
                    }
                }
            }
        }
    }
    None
}

fn get_required_java_version(version_name: &str, mc_dir: &Path) -> Result<u32, String> {
    let json_file = version_json_path(mc_dir, version_name)?;

    if json_file.exists() {
        if let Ok(content) = fs::read_to_string(&json_file) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(major) = parsed["javaVersion"]["majorVersion"].as_u64() {
                    return u32::try_from(major).map_err(|_| "Invalid Java major version".into());
                }
                if let Some(inherits) = parsed["inheritsFrom"].as_str() {
                    let inh_json = version_json_path(mc_dir, inherits)?;
                    if let Ok(inh_content) = fs::read_to_string(&inh_json) {
                        if let Ok(inh_parsed) =
                            serde_json::from_str::<serde_json::Value>(&inh_content)
                        {
                            if let Some(major) = inh_parsed["javaVersion"]["majorVersion"].as_u64()
                            {
                                return u32::try_from(major)
                                    .map_err(|_| "Invalid Java major version".into());
                            }
                        }
                    }
                }
            }
        }
    }

    let lower = version_name.to_ascii_lowercase();
    Ok(if lower.contains("26.") {
        25
    } else if lower.contains("1.21") || lower.contains("1.20.5") || lower.contains("1.20.6") {
        21
    } else if lower.contains("1.17")
        || lower.contains("1.18")
        || lower.contains("1.19")
        || lower.contains("1.20")
    {
        17
    } else {
        8
    })
}

#[derive(Debug, Clone)]
struct FabricModRequirements {
    filename: String,
    mod_id: String,
    minecraft: Vec<String>,
    java: Vec<String>,
}

fn numeric_version_parts(value: &str) -> Option<Vec<u64>> {
    let value = value.trim().trim_start_matches(['v', 'V']);
    let first = value
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .find(|part| !part.is_empty())?;
    let mut result = Vec::new();
    for component in first.split('.') {
        if component.is_empty() {
            continue;
        }
        result.push(component.parse::<u64>().ok()?);
    }
    (!result.is_empty()).then_some(result)
}

fn compare_numeric_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let left = numeric_version_parts(left).unwrap_or_default();
    let right = numeric_version_parts(right).unwrap_or_default();
    let length = left.len().max(right.len());
    for index in 0..length {
        let ordering = left
            .get(index)
            .copied()
            .unwrap_or(0)
            .cmp(&right.get(index).copied().unwrap_or(0));
        if ordering != std::cmp::Ordering::Equal {
            return ordering;
        }
    }
    std::cmp::Ordering::Equal
}

fn first_minecraft_version_token(value: &str) -> Option<String> {
    value
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .map(|part| part.trim_matches('.'))
        .find(|part| {
            part.contains('.')
                && part
                    .chars()
                    .all(|character| character.is_ascii_digit() || character == '.')
        })
        .map(ToOwned::to_owned)
}

fn minecraft_version_for_launch(minecraft_dir: &Path, version_name: &str) -> String {
    let mut current = version_name.to_string();
    for _ in 0..8 {
        let Ok(path) = version_json_path(minecraft_dir, &current) else {
            break;
        };
        let Ok(content) = fs::read_to_string(path) else {
            break;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) else {
            break;
        };
        let Some(parent) = parsed["inheritsFrom"].as_str() else {
            break;
        };
        if parent == current || parent.is_empty() {
            break;
        }
        current = parent.to_string();
    }
    first_minecraft_version_token(&current).unwrap_or(current)
}

fn dependency_strings(value: Option<&serde_json::Value>) -> Vec<String> {
    match value {
        Some(serde_json::Value::String(value)) => vec![value.clone()],
        Some(serde_json::Value::Array(values)) => values
            .iter()
            .filter_map(|value| value.as_str().map(ToOwned::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

fn read_fabric_mod_requirements(path: &Path) -> Option<FabricModRequirements> {
    let file = open_regular_file_no_follow(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let mut entry = archive.by_name("fabric.mod.json").ok()?;
    let mut metadata = String::new();
    entry
        .by_ref()
        .take(1024 * 1024)
        .read_to_string(&mut metadata)
        .ok()?;
    let parsed = serde_json::from_str::<serde_json::Value>(&metadata).ok()?;
    let depends = parsed.get("depends").and_then(|value| value.as_object());
    let minecraft = depends
        .and_then(|values| values.get("minecraft"))
        .map(|value| dependency_strings(Some(value)))
        .unwrap_or_default();
    let java = depends
        .and_then(|values| values.get("java"))
        .map(|value| dependency_strings(Some(value)))
        .unwrap_or_default();
    if minecraft.is_empty() && java.is_empty() {
        return None;
    }
    Some(FabricModRequirements {
        filename: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("unknown.jar")
            .to_string(),
        mod_id: parsed
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown")
            .to_string(),
        minecraft,
        java,
    })
}

fn single_version_requirement_matches(actual: &str, requirement: &str) -> bool {
    let token = requirement.trim().trim_matches([',', ';']);
    if token.is_empty() || token == "*" {
        return true;
    }

    let (operator, base) = if let Some(rest) = token.strip_prefix(">=") {
        (">=", rest.trim())
    } else if let Some(rest) = token.strip_prefix("<=") {
        ("<=", rest.trim())
    } else if let Some(rest) = token.strip_prefix('>') {
        (">", rest.trim())
    } else if let Some(rest) = token.strip_prefix('<') {
        ("<", rest.trim())
    } else if let Some(rest) = token.strip_prefix('~') {
        ("~", rest.trim())
    } else if let Some(rest) = token.strip_prefix('^') {
        ("^", rest.trim())
    } else if let Some(rest) = token.strip_prefix('=') {
        ("=", rest.trim())
    } else {
        ("=", token)
    };
    if base.is_empty() {
        return false;
    }

    if base
        .split('.')
        .any(|part| part.eq_ignore_ascii_case("x") || part == "*")
    {
        let actual_parts = numeric_version_parts(actual).unwrap_or_default();
        return base
            .split('.')
            .zip(actual_parts.iter())
            .all(|(expected, actual)| {
                expected.eq_ignore_ascii_case("x")
                    || expected == "*"
                    || expected.parse::<u64>().ok().as_ref() == Some(actual)
            });
    }

    let base = base.trim_end_matches('-');
    if base.is_empty() {
        return false;
    }
    let comparison = compare_numeric_versions(actual, base);
    match operator {
        ">=" => comparison != std::cmp::Ordering::Less,
        "<=" => comparison != std::cmp::Ordering::Greater,
        ">" => comparison == std::cmp::Ordering::Greater,
        "<" => comparison == std::cmp::Ordering::Less,
        "~" => {
            if comparison == std::cmp::Ordering::Less {
                return false;
            }
            let mut upper = numeric_version_parts(base).unwrap_or_default();
            if upper.len() >= 2 {
                upper[1] = upper[1].saturating_add(1);
                upper.truncate(2);
            }
            let upper = upper
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(".");
            compare_numeric_versions(actual, &upper) == std::cmp::Ordering::Less
        }
        "^" => {
            if comparison == std::cmp::Ordering::Less {
                return false;
            }
            let mut upper = numeric_version_parts(base).unwrap_or_default();
            if upper.first().copied().unwrap_or(0) > 0 {
                upper[0] = upper[0].saturating_add(1);
                upper.truncate(1);
            } else if upper.len() >= 2 {
                upper[1] = upper[1].saturating_add(1);
                upper.truncate(2);
            }
            let upper = upper
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(".");
            compare_numeric_versions(actual, &upper) == std::cmp::Ordering::Less
        }
        _ => comparison == std::cmp::Ordering::Equal,
    }
}

fn version_requirement_matches(actual: &str, requirement: &str) -> bool {
    let tokens: Vec<&str> = requirement
        .split(|character: char| character.is_whitespace() || character == ',')
        .filter(|token| !token.trim().is_empty())
        .collect();
    if tokens.is_empty() {
        return true;
    }
    tokens
        .iter()
        .all(|token| single_version_requirement_matches(actual, token))
}

fn validate_mod_compatibility(
    instance_dir: &Path,
    minecraft_version: &str,
    java_major: u32,
) -> Result<(), String> {
    let mods_dir = canonical_mods_dir(instance_dir);
    let entries = match fs::read_dir(&mods_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Не удалось проверить папку модов: {}", error)),
    };

    let java_version = java_major.to_string();
    let mut issues = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_safe_regular_file(&path) {
            continue;
        }
        let lower = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !lower.ends_with(".jar") {
            continue;
        }
        let Some(requirements) = read_fabric_mod_requirements(&path) else {
            continue;
        };
        let minecraft_ok = requirements
            .minecraft
            .iter()
            .all(|requirement| version_requirement_matches(minecraft_version, requirement));
        let java_ok = requirements
            .java
            .iter()
            .all(|requirement| version_requirement_matches(&java_version, requirement));
        if minecraft_ok && java_ok {
            continue;
        }
        let mut details = Vec::new();
        if !minecraft_ok {
            details.push(format!("Minecraft {}", requirements.minecraft.join("; ")));
        }
        if !java_ok {
            details.push(format!("Java {}", requirements.java.join("; ")));
        }
        issues.push(format!(
            "{} ({}): {}",
            requirements.filename,
            requirements.mod_id,
            details.join(" / ")
        ));
    }

    if issues.is_empty() {
        return Ok(());
    }
    issues.truncate(8);
    Err(format!(
        "Несовместимые моды для Minecraft {} (Java {}):\n• {}\n\nВыберите версию, для которой установлены эти моды, или отключите их в разделе «Моды».",
        minecraft_version,
        java_major,
        issues.join("\n• ")
    ))
}

fn scan_for_javas(dir: &Path, depth: u32, max_depth: u32, found: &mut Vec<(u32, PathBuf)>) {
    if depth > max_depth {
        return;
    }
    match fs::symlink_metadata(dir) {
        Ok(metadata) if metadata.is_dir() && !is_link_metadata(&metadata) => {}
        _ => return,
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let metadata = match entry.file_type() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.is_dir() && !metadata.is_symlink() {
                let jw = path.join("bin").join(JAVA_BIN);
                let j = path.join("bin").join("java.exe");
                let exe = if is_safe_regular_file(&jw) {
                    Some(jw)
                } else if is_safe_regular_file(&j) {
                    Some(j)
                } else {
                    None
                };
                if let Some(p) = exe {
                    if let Some(v) = check_java_version(&p) {
                        found.push((v, p));
                    }
                }
                scan_for_javas(&path, depth + 1, max_depth, found);
            }
        }
    }
}

fn find_java_on_path() -> Option<PathBuf> {
    #[cfg(windows)]
    const EXECUTABLE: &str = "java.exe";
    #[cfg(not(windows))]
    const EXECUTABLE: &str = "java";

    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|directory| {
        if !directory.is_absolute() {
            return None;
        }
        let candidate = directory.join(EXECUTABLE);
        let metadata = fs::symlink_metadata(&candidate).ok()?;
        if metadata.is_file() && !is_link_metadata(&metadata) {
            Some(candidate)
        } else {
            None
        }
    })
}

fn choose_java_candidate(candidates: &[(u32, PathBuf)], required_major: u32) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|(major, _)| *major == required_major)
        .map(|(_, path)| path.clone())
}

fn find_existing_java(mc_dir: &Path, required_major: u32) -> Option<PathBuf> {
    let mut candidates: Vec<(u32, PathBuf)> = Vec::new();

    let runtime_dir = mc_dir.join("runtime");
    scan_for_javas(&runtime_dir, 0, 3, &mut candidates);

    if let Ok(appdata) = std::env::var("APPDATA") {
        let sk_runtime = PathBuf::from(&appdata).join(".sklauncher").join("runtime");
        scan_for_javas(&sk_runtime, 0, 4, &mut candidates);

        let kj_runtime = PathBuf::from(&appdata).join("kjstudio");
        scan_for_javas(&kj_runtime, 0, 4, &mut candidates);
    }

    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        let mojang_runtime = PathBuf::from(&localappdata)
            .join("Packages")
            .join("Microsoft.4297127D64C57_8wekyb3d8bbwe")
            .join("LocalCache")
            .join("Local")
            .join("runtime");
        scan_for_javas(&mojang_runtime, 0, 4, &mut candidates);
    }

    let candidate_dirs = [
        r"C:\Program Files (x86)\Minecraft Launcher\runtime",
        r"C:\Program Files\Eclipse Adoptium",
        r"C:\Program Files\Java",
        r"C:\Program Files\BellSoft",
        r"C:\Program Files\Zulu",
        r"C:\Program Files (x86)\Java",
        r"C:\Program Files (x86)\AudioRelay\runtime",
    ];

    for base in candidate_dirs {
        scan_for_javas(&PathBuf::from(base), 0, 3, &mut candidates);
    }

    if let Ok(home) = std::env::var("JAVA_HOME") {
        let home_path = PathBuf::from(home);
        if home_path.is_absolute() {
            let p_jw = home_path.join("bin").join(JAVA_BIN);
            let p_j = home_path.join("bin").join("java.exe");
            let exe = if is_safe_regular_file(&p_jw) {
                Some(p_jw)
            } else if is_safe_regular_file(&p_j) {
                Some(p_j)
            } else {
                None
            };
            if let Some(p) = exe {
                if let Some(v) = check_java_version(&p) {
                    candidates.push((v, p));
                }
            }
        }
    }

    if let Some(path_candidate) = find_java_on_path() {
        if let Some(major) = check_java_version(&path_candidate) {
            candidates.push((major, path_candidate));
        }
    }

    choose_java_candidate(&candidates, required_major)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JavaArchiveKind {
    Zip,
    TarGz,
}

impl JavaArchiveKind {
    fn extension(self) -> &'static str {
        match self {
            Self::Zip => ".zip",
            Self::TarGz => ".tar.gz",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AdoptiumJrePackage {
    url: String,
    checksum: String,
    size: u64,
    name: String,
    kind: JavaArchiveKind,
}

fn adoptium_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    }
}

fn adoptium_architecture() -> Result<&'static str, String> {
    match std::env::consts::ARCH {
        "x86" => Ok("x86"),
        "x86_64" => Ok("x64"),
        "aarch64" => Ok("aarch64"),
        other => Err(format!("Unsupported Adoptium architecture: {}", other)),
    }
}

fn java_archive_kind_for(os: &str) -> Result<JavaArchiveKind, String> {
    match os {
        "windows" => Ok(JavaArchiveKind::Zip),
        "linux" | "mac" => Ok(JavaArchiveKind::TarGz),
        other => Err(format!("Unsupported Adoptium OS: {}", other)),
    }
}

fn adoptium_feature_releases_url(
    required_major: u32,
    os: &str,
    architecture: &str,
) -> Result<String, String> {
    if required_major == 0 {
        return Err("Java major version must be greater than zero".into());
    }
    if !matches!(os, "windows" | "linux" | "mac") {
        return Err(format!("Unsupported Adoptium OS: {}", os));
    }
    if !matches!(architecture, "x86" | "x64" | "aarch64") {
        return Err(format!(
            "Unsupported Adoptium architecture: {}",
            architecture
        ));
    }
    Ok(format!(
        "https://api.adoptium.net/v3/assets/feature_releases/{}/ga?architecture={}&heap_size=normal&image_type=jre&jvm_impl=hotspot&os={}&vendor=eclipse&page=0&page_size=1",
        required_major, architecture, os
    ))
}

fn parse_adoptium_feature_releases(
    metadata: &str,
    required_major: u32,
    os: &str,
    architecture: &str,
) -> Result<AdoptiumJrePackage, String> {
    let expected_kind = java_archive_kind_for(os)?;
    if !matches!(architecture, "x86" | "x64" | "aarch64") {
        return Err(format!(
            "Unsupported Adoptium architecture: {}",
            architecture
        ));
    }
    let value: serde_json::Value = serde_json::from_str(metadata)
        .map_err(|error| format!("Некорректный Adoptium asset manifest: {}", error))?;
    let releases = value
        .as_array()
        .ok_or_else(|| "Adoptium feature_releases response is not an array".to_string())?;
    if releases.is_empty() {
        return Err(format!("Adoptium не выпустил JRE {}", required_major));
    }

    for release in releases {
        let major = release
            .get("version_data")
            .and_then(|value| value.get("major"))
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "Adoptium release is missing version_data.major".to_string())?;
        if major != required_major as u64 {
            continue;
        }
        let binaries = release
            .get("binaries")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| {
                format!(
                    "Adoptium release for Java {} has no binaries array",
                    required_major
                )
            })?;
        for binary in binaries {
            let matches = binary.get("architecture").and_then(|v| v.as_str()) == Some(architecture)
                && binary.get("heap_size").and_then(|v| v.as_str()) == Some("normal")
                && binary.get("image_type").and_then(|v| v.as_str()) == Some("jre")
                && binary.get("jvm_impl").and_then(|v| v.as_str()) == Some("hotspot")
                && binary.get("os").and_then(|v| v.as_str()) == Some(os);
            if !matches {
                continue;
            }

            let package = binary
                .get("package")
                .and_then(serde_json::Value::as_object)
                .ok_or_else(|| "Adoptium binary has no package object".to_string())?;
            let url = package
                .get("link")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "В Adoptium asset отсутствует ссылка".to_string())?;
            let name = package
                .get("name")
                .and_then(|value| value.as_str())
                .ok_or_else(|| "В Adoptium asset отсутствует имя пакета".to_string())?;
            validate_safe_component(name, "Adoptium package name")?;
            let checksum = package
                .get("checksum")
                .and_then(|value| value.as_str())
                .ok_or_else(|| "В Adoptium asset отсутствует SHA-256".to_string())?
                .trim()
                .to_ascii_lowercase();
            if checksum.len() != 64 || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("Некорректный SHA-256 в Adoptium asset".into());
            }
            let size = package
                .get("size")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| "В Adoptium asset отсутствует размер пакета".to_string())?;
            if size == 0 || size > JAVA_ARCHIVE_MAX_BYTES {
                return Err("Java archive exceeds the 300 MiB safety limit".into());
            }
            validate_url(url)?;
            let parsed_url = reqwest::Url::parse(url)
                .map_err(|_| "Malformed Adoptium package URL".to_string())?;
            let lower_name = name.to_ascii_lowercase();
            let lower_url_path = parsed_url.path().to_ascii_lowercase();
            if !lower_name.ends_with(expected_kind.extension())
                || !lower_url_path.ends_with(expected_kind.extension())
            {
                return Err(format!(
                    "Adoptium package must be a {} archive for {}",
                    expected_kind.extension(),
                    os
                ));
            }
            return Ok(AdoptiumJrePackage {
                url: url.to_string(),
                checksum,
                size,
                name: name.to_string(),
                kind: expected_kind,
            });
        }
    }

    Err(format!(
        "Adoptium не выпустил JRE {} для {} / {}",
        required_major, os, architecture
    ))
}

fn safe_archive_relative_path(raw_name: &str) -> Result<PathBuf, String> {
    let normalized = raw_name.replace('\\', "/");
    if normalized.starts_with('/') || normalized.contains('\0') {
        return Err("Java archive contains an unsafe path".into());
    }
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Java archive contains an empty path".into());
    }
    safe_relative_path(trimmed)
}

fn prepare_archive_output(
    unpack_dir: &Path,
    relative: &Path,
    is_directory: bool,
) -> Result<(PathBuf, Option<fs::File>), String> {
    let output = unpack_dir.join(relative);
    if is_directory {
        ensure_directory_no_follow(&output)?;
        return Ok((output, None));
    }
    if let Some(parent) = output.parent() {
        ensure_directory_no_follow(parent)?;
    }
    if fs::symlink_metadata(&output).is_ok() {
        return Err("Java archive contains duplicate output paths".into());
    }
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)
        .map_err(|error| format!("Failed to create Java file: {}", error))?;
    Ok((output, Some(file)))
}

#[cfg(unix)]
fn apply_archive_mode(path: &Path, mode: Option<u32>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o7777))
            .map_err(|error| format!("Failed to set Java file permissions: {}", error))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn apply_archive_mode(_path: &Path, _mode: Option<u32>) -> Result<(), String> {
    Ok(())
}

fn extract_java_zip(archive_path: &Path, unpack_dir: &Path) -> Result<(), String> {
    use std::collections::HashSet;

    let file = open_regular_file_no_follow(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("Failed to read Java archive: {}", error))?;
    if archive.len() > JAVA_MAX_ARCHIVE_ENTRIES {
        return Err("Java archive contains too many entries".into());
    }

    let mut total_uncompressed = 0u64;
    let mut paths = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read Java archive entry: {}", error))?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170_000 == 0o120_000)
        {
            return Err("Java archive contains a symbolic link".into());
        }
        let entry_size = entry.size();
        if entry_size > JAVA_MAX_ENTRY_BYTES {
            return Err("A Java archive entry is too large".into());
        }
        total_uncompressed = total_uncompressed
            .checked_add(entry_size)
            .ok_or_else(|| "Java archive size overflow".to_string())?;
        if total_uncompressed > JAVA_UNPACK_MAX_BYTES {
            return Err("Java archive expands beyond the 2 GiB safety limit".into());
        }
        if entry.compressed_size() > 0
            && entry_size / entry.compressed_size() > JAVA_MAX_COMPRESSION_RATIO
        {
            return Err("Java archive compression ratio is unsafe".into());
        }
        let relative = safe_archive_relative_path(entry.name())?;
        if !paths.insert(relative.clone()) {
            return Err("Java archive contains duplicate paths".into());
        }
        let is_directory = entry.is_dir()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170_000 == 0o040_000);
        let (output, output_file) = prepare_archive_output(unpack_dir, &relative, is_directory)?;
        if let Some(mut output_file) = output_file {
            let written = std::io::copy(&mut entry, &mut output_file)
                .map_err(|error| format!("Failed to extract Java file: {}", error))?;
            if written != entry_size {
                return Err("Java archive entry was truncated".into());
            }
            output_file
                .sync_all()
                .map_err(|error| format!("Failed to flush Java file: {}", error))?;
            drop(output_file);
        }
        apply_archive_mode(&output, entry.unix_mode())?;
    }
    Ok(())
}

fn extract_java_tar_gz(archive_path: &Path, unpack_dir: &Path) -> Result<(), String> {
    use std::collections::HashSet;

    let compressed_size = fs::symlink_metadata(archive_path)
        .map_err(|error| format!("Failed to inspect Java tar archive: {}", error))?
        .len();
    let file = open_regular_file_no_follow(archive_path)?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("Failed to read Java tar archive: {}", error))?;
    let mut total_uncompressed = 0u64;
    let mut entry_count = 0usize;
    let mut paths = HashSet::new();
    for entry in entries {
        let mut entry =
            entry.map_err(|error| format!("Failed to read Java tar entry: {}", error))?;
        entry_count += 1;
        if entry_count > JAVA_MAX_ARCHIVE_ENTRIES {
            return Err("Java archive contains too many entries".into());
        }
        let kind = entry.header().entry_type();
        if kind.is_pax_global_extensions()
            || kind.is_pax_local_extensions()
            || kind.is_gnu_longname()
            || kind.is_gnu_longlink()
        {
            continue;
        }
        if kind.is_symlink() || kind.is_hard_link() {
            return Err("Java archive contains a link entry".into());
        }
        if !kind.is_file() && !kind.is_dir() {
            return Err("Java archive contains a special file".into());
        }
        let path = entry
            .path()
            .map_err(|error| format!("Java archive contains an invalid path: {}", error))?
            .to_string_lossy()
            .into_owned();
        let relative = safe_archive_relative_path(&path)?;
        if !paths.insert(relative.clone()) {
            return Err("Java archive contains duplicate paths".into());
        }
        let entry_size = if kind.is_file() { entry.size() } else { 0 };
        if entry_size > JAVA_MAX_ENTRY_BYTES {
            return Err("A Java archive entry is too large".into());
        }
        total_uncompressed = total_uncompressed
            .checked_add(entry_size)
            .ok_or_else(|| "Java archive size overflow".to_string())?;
        if total_uncompressed > JAVA_UNPACK_MAX_BYTES {
            return Err("Java archive expands beyond the 2 GiB safety limit".into());
        }
        let (output, output_file) = prepare_archive_output(unpack_dir, &relative, kind.is_dir())?;
        if let Some(mut output_file) = output_file {
            let written = std::io::copy(&mut entry, &mut output_file)
                .map_err(|error| format!("Failed to extract Java file: {}", error))?;
            if written != entry_size {
                return Err("Java archive entry was truncated".into());
            }
            output_file
                .sync_all()
                .map_err(|error| format!("Failed to flush Java file: {}", error))?;
            drop(output_file);
        }
        let mode = entry.header().mode().ok();
        apply_archive_mode(&output, mode)?;
    }
    if compressed_size > 0 && total_uncompressed / compressed_size > JAVA_MAX_COMPRESSION_RATIO {
        return Err("Java archive compression ratio is unsafe".into());
    }
    Ok(())
}

fn extract_java_archive(
    archive_path: &Path,
    unpack_dir: &Path,
    kind: JavaArchiveKind,
) -> Result<(), String> {
    ensure_directory_no_follow(unpack_dir)?;
    match kind {
        JavaArchiveKind::Zip => extract_java_zip(archive_path, unpack_dir),
        JavaArchiveKind::TarGz => extract_java_tar_gz(archive_path, unpack_dir),
    }
}

async fn auto_download_java(
    app: &tauri::AppHandle,
    mc_dir: &Path,
    required_major: u32,
) -> Result<PathBuf, String> {
    let runtime_dir = mc_dir.join("runtime");
    let target_dir = runtime_dir.join(format!("java-{}", required_major));
    let _install_guard = acquire_java_install(required_major)?;
    let _process_lock = acquire_java_process_lock(required_major)?;
    ensure_directory_no_follow(&runtime_dir)
        .map_err(|error| format!("Failed to create runtime dir: {}", error))?;

    #[cfg(windows)]
    const CONSOLE_JAVA: &str = "java.exe";
    #[cfg(not(windows))]
    const CONSOLE_JAVA: &str = "java";
    let existing_candidates = [
        target_dir.join("bin").join(JAVA_BIN),
        target_dir.join("bin").join(CONSOLE_JAVA),
    ];
    for candidate in existing_candidates {
        let metadata = match fs::symlink_metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Failed to inspect Java runtime: {}", error)),
        };
        if is_link_metadata(&metadata) {
            return Err("Java runtime executable is a symlink".into());
        }
        if metadata.is_file() && check_java_version(&candidate) == Some(required_major) {
            return Ok(candidate);
        }
    }

    let _ = app.emit(
        "download-progress",
        ProgressPayload {
            version: format!("Java {}", required_major),
            percent: 5,
            current: 0,
            total: 50_000_000,
            stage: format!("Загрузка Java {}...", required_major),
        },
    );

    let os_name = adoptium_os();
    let architecture = adoptium_architecture()?;
    let metadata_url = adoptium_feature_releases_url(required_major, os_name, architecture)?;
    let metadata_text = fetch_text_limited(&metadata_url, JAVA_METADATA_MAX_BYTES).await?;
    let package =
        parse_adoptium_feature_releases(&metadata_text, required_major, os_name, architecture)?;
    let archive_path = runtime_dir.join(format!(
        "java-{}-{}{}",
        required_major,
        os_name,
        package.kind.extension()
    ));

    let cached_valid = match fs::symlink_metadata(&archive_path) {
        Ok(metadata)
            if !is_link_metadata(&metadata)
                && metadata.is_file()
                && metadata.len() == package.size
                && verify_sha256(&archive_path, &package.checksum).is_ok() =>
        {
            true
        }
        Ok(metadata) if is_link_metadata(&metadata) => {
            return Err("Java archive cache is a symlink".into());
        }
        Ok(metadata) if metadata.is_file() => false,
        Ok(_) => return Err("Java archive cache is not a regular file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("Failed to inspect Java archive cache: {}", error)),
    };
    if !cached_valid {
        let _ = remove_file_no_follow(&archive_path);
        let _ = app.emit(
            "download-progress",
            ProgressPayload {
                version: format!("Java {}", required_major),
                percent: 10,
                current: 0,
                total: package.size,
                stage: format!("Загрузка Java {}...", required_major),
            },
        );
        download_file_http_limited_with_expected_size(
            &package.url,
            &archive_path,
            JAVA_ARCHIVE_MAX_BYTES,
            Some(package.size),
        )
        .await?;
        if let Err(error) = verify_sha256(&archive_path, &package.checksum) {
            let _ = remove_file_no_follow(&archive_path);
            return Err(error);
        }
    }

    let archive_metadata = fs::symlink_metadata(&archive_path)
        .map_err(|error| format!("Failed to inspect Java archive: {}", error))?;
    if is_link_metadata(&archive_metadata)
        || !archive_metadata.is_file()
        || archive_metadata.len() != package.size
    {
        return Err("Java archive size or file type is invalid".into());
    }
    if let Err(error) = verify_sha256(&archive_path, &package.checksum) {
        let _ = remove_file_no_follow(&archive_path);
        return Err(error);
    }

    let _ = app.emit(
        "download-progress",
        ProgressPayload {
            version: format!("Java {}", required_major),
            percent: 80,
            current: package.size,
            total: package.size,
            stage: format!("Распаковка Java {}...", required_major),
        },
    );

    let unpack_dir =
        create_unique_directory_no_follow(&runtime_dir, &format!(".java-{}-", required_major))?;
    let install_result = (|| -> Result<PathBuf, String> {
        extract_java_archive(&archive_path, &unpack_dir, package.kind)?;

        let mut candidates = vec![(unpack_dir.clone(), 0u32)];
        let mut source_dir = None;
        while let Some((directory, depth)) = candidates.pop() {
            if depth > 16 {
                return Err("Java archive directory nesting is too deep".into());
            }
            let executable = directory.join("bin").join(CONSOLE_JAVA);
            if let Ok(metadata) = fs::symlink_metadata(&executable) {
                if metadata.is_file()
                    && !is_link_metadata(&metadata)
                    && check_java_version(&executable) == Some(required_major)
                {
                    source_dir = Some(directory);
                    break;
                }
            }
            if let Ok(entries) = fs::read_dir(&directory) {
                for entry in entries.flatten() {
                    let metadata = match entry.file_type() {
                        Ok(metadata) => metadata,
                        Err(_) => continue,
                    };
                    if metadata.is_dir() && !metadata.is_symlink() {
                        candidates.push((entry.path(), depth + 1));
                    }
                }
            }
        }
        let source_dir = source_dir
            .ok_or_else(|| format!("Java executable {} not found in archive", CONSOLE_JAVA))?;

        if let Ok(metadata) = fs::symlink_metadata(&target_dir) {
            if is_link_metadata(&metadata) || !metadata.is_dir() {
                return Err("Java target directory is not a safe directory".into());
            }
            remove_tree_no_follow(&target_dir)
                .map_err(|error| format!("Failed to replace Java target: {}", error))?;
        }
        fs::rename(&source_dir, &target_dir)
            .map_err(|error| format!("Failed to install Java runtime: {}", error))?;
        let installed = target_dir.join("bin").join(CONSOLE_JAVA);
        let metadata = fs::symlink_metadata(&installed)
            .map_err(|error| format!("Installed Java runtime is unavailable: {}", error))?;
        if is_link_metadata(&metadata) || !metadata.is_file() {
            return Err("Installed Java runtime has no safe console executable".into());
        }
        if check_java_version(&installed) != Some(required_major) {
            return Err(format!("Installed runtime is not Java {}", required_major));
        }
        Ok(installed)
    })();

    let _ = remove_file_no_follow(&archive_path);
    let _ = remove_tree_no_follow(&unpack_dir);
    let result = install_result?;

    let _ = app.emit(
        "download-progress",
        ProgressPayload {
            version: format!("Java {}", required_major),
            percent: 100,
            current: package.size,
            total: package.size,
            stage: "Java готова!".into(),
        },
    );

    Ok(result)
}

fn extract_natives(native_jars: &[PathBuf], natives_dir: &Path) -> Result<usize, String> {
    ensure_directory_no_follow(natives_dir)
        .map_err(|error| format!("Failed to create natives directory: {}", error))?;
    let mut extracted = 0usize;
    let mut total_bytes = 0u64;

    for jar in native_jars {
        use zip::ZipArchive;
        let file = open_regular_file_no_follow(jar).map_err(|error| {
            format!("Failed to open native archive {}: {}", jar.display(), error)
        })?;
        let mut archive = ZipArchive::new(file).map_err(|error| {
            format!("Failed to read native archive {}: {}", jar.display(), error)
        })?;
        if archive.len() > 10_000 {
            return Err("Native archive contains too many entries".into());
        }

        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("Failed to read native archive entry: {}", error))?;
            if entry.is_dir() {
                continue;
            }
            let raw_name = entry.name().replace('\\', "/").to_ascii_lowercase();
            if raw_name.starts_with("meta-inf/") || raw_name.contains("/meta-inf/") {
                continue;
            }
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170_000 == 0o120_000)
            {
                return Err("Native archive contains a symbolic link".into());
            }
            let name = Path::new(entry.name())
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| "Native archive entry has an invalid name".to_string())?
                .to_string();
            validate_safe_component(&name, "native file name")?;
            let lower = name.to_ascii_lowercase();
            if !(lower.ends_with(".dll")
                || lower.ends_with(".so")
                || lower.ends_with(".dylib")
                || lower.ends_with(".jnilib"))
            {
                continue;
            }
            if entry.size() > 100 * 1024 * 1024 {
                return Err("Native library exceeds the 100 MiB safety limit".into());
            }
            total_bytes = total_bytes
                .checked_add(entry.size())
                .ok_or_else(|| "Native archive size overflow".to_string())?;
            if total_bytes > 500 * 1024 * 1024 {
                return Err("Native libraries exceed the 500 MiB safety limit".into());
            }

            let destination = natives_dir.join(&name);
            match fs::symlink_metadata(&destination) {
                Ok(metadata) => {
                    if is_link_metadata(&metadata) || !metadata.is_file() {
                        return Err(format!(
                            "Refusing to replace non-regular native library {}",
                            destination.display()
                        ));
                    }
                    if metadata.len() == entry.size() {
                        extracted += 1;
                        continue;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "Failed to inspect native library {}: {}",
                        destination.display(),
                        error
                    ));
                }
            }
            let (temp, mut output) = create_temporary_download(&destination)?;
            let result = (|| -> std::io::Result<()> {
                let written = std::io::copy(&mut entry, &mut output)?;
                if written != entry.size() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "native archive entry was truncated",
                    ));
                }
                output.sync_all()?;
                drop(output);
                commit_download(&temp, &destination).map_err(std::io::Error::other)
            })();
            if let Err(error) = result {
                let _ = remove_file_no_follow(&temp);
                return Err(format!(
                    "Failed to extract native library {}: {}",
                    name, error
                ));
            }
            extracted += 1;
        }
    }
    Ok(extracted)
}
#[allow(clippy::chunks_exact_to_as_chunks)]
fn md5(input: &[u8]) -> [u8; 16] {
    let mut state: [u32; 4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut msg = input.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());

    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];

    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
        0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
        0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
        0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
        0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
        0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
        0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
        0xeb86d391,
    ];

    for chunk in msg.chunks_exact(64) {
        let mut m = [0u32; 16];
        for i in 0..16 {
            m[i] = u32::from_le_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        let mut a = state[0];
        let mut b = state[1];
        let mut c = state[2];
        let mut d = state[3];

        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | ((!b) & d), i),
                16..=31 => ((d & b) | ((!d) & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | (!d)), (7 * i) % 16),
            };
            let temp = d;
            d = c;
            c = b;
            b = b.wrapping_add(
                (a.wrapping_add(f).wrapping_add(K[i]).wrapping_add(m[g])).rotate_left(S[i]),
            );
            a = temp;
        }

        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
    }

    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&state[0].to_le_bytes());
    out[4..8].copy_from_slice(&state[1].to_le_bytes());
    out[8..12].copy_from_slice(&state[2].to_le_bytes());
    out[12..16].copy_from_slice(&state[3].to_le_bytes());
    out
}

fn offline_uuid(nickname: &str) -> String {
    let input = format!("OfflinePlayer:{}", nickname);
    let mut hash = md5(input.as_bytes());
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        hash[0], hash[1], hash[2], hash[3],
        hash[4], hash[5],
        hash[6], hash[7],
        hash[8], hash[9],
        hash[10], hash[11], hash[12], hash[13], hash[14], hash[15]
    )
}

fn is_safe_metadata_jvm_arg(argument: &str) -> bool {
    let lower = argument.to_ascii_lowercase();
    !(lower.starts_with("-xmx")
        || lower.starts_with("-xms")
        || lower.starts_with("-xbootclasspath")
        || lower.starts_with("-javaagent")
        || lower.starts_with("-agentlib")
        || lower.starts_with("-agentpath")
        || lower.starts_with("-xx:onoutofmemoryerror")
        || lower.starts_with("-xx:onerror")
        || lower.contains("onerror="))
}

fn is_java_class_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value.split('.').all(|segment| {
            !segment.is_empty()
                && segment.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '$')
                })
                && !segment
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_digit())
        })
}

fn collect_game_arguments(parsed: &serde_json::Value) -> Vec<String> {
    if let Some(arguments) = parsed["arguments"]["game"].as_array() {
        let mut result = Vec::new();
        for item in arguments {
            if let Some(value) = item.as_str() {
                result.push(value.to_string());
            } else if let Some(object) = item.as_object() {
                if let Some(rules) = object.get("rules").and_then(|value| value.as_array()) {
                    if !is_rule_allowed(Some(rules)) {
                        continue;
                    }
                }
                if let Some(value) = object.get("value").and_then(|value| value.as_str()) {
                    result.push(value.to_string());
                } else if let Some(values) = object.get("value").and_then(|value| value.as_array())
                {
                    result.extend(
                        values
                            .iter()
                            .filter_map(|value| value.as_str())
                            .map(ToOwned::to_owned),
                    );
                }
            }
        }
        result
    } else if let Some(arguments) = parsed["minecraftArguments"].as_str() {
        arguments
            .split_whitespace()
            .map(ToOwned::to_owned)
            .collect()
    } else {
        Vec::new()
    }
}

#[tauri::command]
async fn launch_game(
    app: tauri::AppHandle,
    version_name: String,
    nickname: String,
    ram_mb: u32,
) -> Result<String, String> {
    validate_version_id(&version_name)?;
    if nickname.is_empty()
        || nickname.len() > 16
        || !nickname
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        return Err("Некорректный никнейм".into());
    }
    if !(512..=131_072).contains(&ram_mb) {
        return Err("Недопустимый объём памяти игры".into());
    }
    let mc_dir = get_minecraft_dir();
    let version_dir = version_game_dir(&mc_dir, &version_name)?;
    let instance_dir = version_dir.clone();
    let version_run_guard = acquire_version_run(&version_name)?;
    let version_process_lock = acquire_version_process_lock(&version_name)?;
    let mut jar_file = version_dir.join(format!("{}.jar", version_name));
    let json_file = version_dir.join(format!("{}.json", version_name));

    let mut main_class = "net.minecraft.client.main.Main".to_string();
    let mut asset_index = "legacy".to_string();
    let mut jvm_args_from_json = Vec::new();
    let mut game_args_from_json = Vec::new();

    if json_file.exists() {
        if let Ok(content) = fs::read_to_string(&json_file) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(m) = parsed["mainClass"].as_str() {
                    if !is_java_class_name(m) {
                        return Err(format!("Некорректный mainClass в версии {}", version_name));
                    }
                    main_class = m.to_string();
                }
                if let Some(ai) = parsed["assetIndex"]["id"].as_str() {
                    asset_index = ai.to_string();
                }
                if let Some(jvm_arr) = parsed["arguments"]["jvm"].as_array() {
                    for item in jvm_arr {
                        if let Some(s) = item.as_str() {
                            if s == "-cp" || s == "${classpath}" {
                                continue;
                            }
                            if is_safe_metadata_jvm_arg(s) {
                                jvm_args_from_json.push(s.to_string());
                            }
                        } else if let Some(obj) = item.as_object() {
                            if let Some(rules) = obj.get("rules").and_then(|r| r.as_array()) {
                                if !is_rule_allowed(Some(rules)) {
                                    continue;
                                }
                            }
                            if let Some(val) = obj.get("value") {
                                if let Some(s) = val.as_str() {
                                    if is_safe_metadata_jvm_arg(s) {
                                        jvm_args_from_json.push(s.to_string());
                                    }
                                } else if let Some(arr) = val.as_array() {
                                    for v in arr {
                                        if let Some(s) = v.as_str() {
                                            if is_safe_metadata_jvm_arg(s) {
                                                jvm_args_from_json.push(s.to_string());
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                game_args_from_json = collect_game_arguments(&parsed);
                if !jar_file.exists() {
                    if let Some(inherits) = parsed["inheritsFrom"].as_str() {
                        validate_version_id(inherits)?;
                        let parent_dir = version_directory(&mc_dir, inherits)?;
                        let inh_jar1 = version_dir.join(format!("{}.jar", inherits));
                        let inh_jar2 = parent_dir.join(format!("{}.jar", inherits));
                        if inh_jar1.exists() {
                            jar_file = inh_jar1;
                        } else if inh_jar2.exists() {
                            jar_file = inh_jar2;
                        }
                    }
                }
            }
        }
    }

    if !jar_file.exists() {
        return Err(format!(
            "Клиентский файл версии {} не найден. Сначала скачайте её.",
            version_name
        ));
    }

    let required_major = get_required_java_version(&version_name, &mc_dir)?;
    let launch_minecraft_version = minecraft_version_for_launch(&mc_dir, &version_name);
    validate_mod_compatibility(&instance_dir, &launch_minecraft_version, required_major)?;
    eprintln!(
        "[launch] version={} required_java={}",
        version_name, required_major
    );
    let java_path = match find_existing_java(&mc_dir, required_major) {
        Some(p) => {
            eprintln!("[launch] found existing java: {}", p.display());
            p
        }
        None => {
            eprintln!(
                "[launch] no suitable java found, auto-downloading Java {}",
                required_major
            );
            match auto_download_java(&app, &mc_dir, required_major).await {
                Ok(p) => {
                    eprintln!("[launch] auto-downloaded java: {}", p.display());
                    p
                }
                Err(e) => {
                    eprintln!("[launch] auto-download FAILED: {}", e);
                    return Err(format!(
                        "Не удалось получить Java {}: {}",
                        required_major, e
                    ));
                }
            }
        }
    };

    let mut target_libs = Vec::new();
    let mut requires_native_extraction = false;
    let libraries_dir = mc_dir.join("libraries");
    if json_file.exists() {
        if let Ok(content) = fs::read_to_string(&json_file) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                requires_native_extraction |= has_legacy_native_metadata(&parsed);
                target_libs.extend(parse_libraries_from_json(&parsed, &libraries_dir));

                if let Some(inherits) = parsed["inheritsFrom"].as_str() {
                    validate_version_id(inherits)?;
                    let inh_json = version_json_path(&mc_dir, inherits)?;
                    if inh_json.exists() {
                        if let Ok(inh_content) = fs::read_to_string(&inh_json) {
                            if let Ok(inh_parsed) =
                                serde_json::from_str::<serde_json::Value>(&inh_content)
                            {
                                requires_native_extraction |=
                                    has_legacy_native_metadata(&inh_parsed);
                                target_libs
                                    .extend(parse_libraries_from_json(&inh_parsed, &libraries_dir));
                                if game_args_from_json.is_empty() {
                                    game_args_from_json = collect_game_arguments(&inh_parsed);
                                }
                                if asset_index == "legacy" {
                                    if let Some(ai) = inh_parsed["assetIndex"]["id"].as_str() {
                                        asset_index = ai.to_string();
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if required_major >= 25 {
        for item in &mut target_libs {
            let s = item.dest.to_string_lossy().replace('\\', "/");
            if s.contains("org/ow2/asm") && s.contains("9.7.1") {
                let new_path = s.replace("9.7.1", "9.10.1");
                item.dest = PathBuf::from(new_path);
                item.url = item
                    .url
                    .replace("9.7.1", "9.10.1")
                    .replace("maven.fabricmc.net", "repo1.maven.org/maven2");
                item.sha1 = None;
                item.size = None;
            }
        }
    }

    let shared_content_guard = acquire_shared_content_process_lock().map_err(|error| {
        format!(
            "Другая операция с общими файлами ещё выполняется (установка версии, Forge или NeoForge). {}",
            error
        )
    })?;
    download_libraries_parallel(target_libs.clone()).await?;

    let mut cp_entries = vec![jar_file.to_string_lossy().to_string()];
    let mut seen_jars = std::collections::HashSet::new();
    let mut native_jars: Vec<PathBuf> = Vec::new();
    for item in target_libs {
        if !item.dest.exists() {
            continue;
        }
        if item.is_native {
            native_jars.push(item.dest);
            continue;
        }
        let key = item.dest.to_string_lossy().to_string();
        if !seen_jars.contains(&key) {
            seen_jars.insert(key.clone());
            cp_entries.push(key);
        }
    }

    let classpath = cp_entries.join(CLASSPATH_SEP);
    let ram = if ram_mb < 1024 { 2048 } else { ram_mb };
    let assets_dir = mc_dir.join("assets");
    let uuid = offline_uuid(&nickname);
    let user_home = dirs::home_dir();

    let natives_dir = version_dir.join("natives");
    let _ = fs::create_dir_all(&natives_dir);
    if !native_jars.is_empty() {
        let extracted = extract_natives(&native_jars, &natives_dir)?;
        if extracted == 0 {
            return Err(
                "Не найдены нативные библиотеки (natives) для этой версии — перекачайте её.".into(),
            );
        }
        eprintln!(
            "[launch] extracted {} native files to {}",
            extracted,
            natives_dir.display()
        );
    } else if requires_native_extraction {
        return Err(
            "Native-библиотеки для этой старой версии не найдены. Переустановите версию или перекачайте её библиотеки."
                .into(),
        );
    } else {
        eprintln!("[launch] no natives to extract (modern classpath natives)");
    }
    for sub in ["java", "jna", "lwjgl", "netty"] {
        let _ = fs::create_dir_all(natives_dir.join(sub));
    }
    drop(shared_content_guard);

    let launch_exe = {
        let name = java_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.eq_ignore_ascii_case("javaw.exe") {
            let alt = java_path.with_file_name("java.exe");
            if alt.exists() {
                alt
            } else {
                java_path.clone()
            }
        } else {
            java_path.clone()
        }
    };
    eprintln!("[launch] java exe: {}", launch_exe.display());

    let mut cmd = Command::new(&launch_exe);
    cmd.arg(format!("-Xmx{}M", ram));
    cmd.arg(format!("-Xms{}M", ram));
    cmd.arg("-Dfile.encoding=UTF-8");
    if let Some(home) = user_home {
        cmd.arg(format!("-Duser.home={}", home.to_string_lossy()));
    }
    let version_mods = canonical_mods_dir(&instance_dir);
    ensure_directory_no_follow(&version_mods)
        .map_err(|error| format!("Failed to create mods directory: {}", error))?;
    let lower_version = version_name.to_ascii_lowercase();
    if lower_version.contains("fabric") {
        cmd.arg(format!(
            "-Dfabric.modsFolder={}",
            version_mods.to_string_lossy()
        ));
    }
    eprintln!("[launch] mods folder: {}", version_mods.display());
    if required_major >= 17 {
        cmd.args([
            "-XX:+UseG1GC",
            "-XX:MaxGCPauseMillis=100",
            "-XX:+UnlockExperimentalVMOptions",
            "-XX:+DisableExplicitGC",
            "-XX:+AlwaysPreTouch",
            "-XX:G1NewSizePercent=40",
            "-XX:G1MaxNewSizePercent=50",
            "-XX:G1HeapRegionSize=8M",
            "-XX:G1ReservePercent=20",
            "-XX:G1HeapWastePercent=5",
            "-XX:G1MixedGCCountTarget=4",
            "-XX:InitiatingHeapOccupancyPercent=15",
            "-XX:G1MixedGCLiveThresholdPercent=90",
            "-XX:SurvivorRatio=32",
            "-XX:+PerfDisableSharedMem",
            "-XX:MaxTenuringThreshold=1",
        ]);
    }

    let natives_str = natives_dir.to_string_lossy().to_string();
    if jvm_args_from_json.is_empty() {
        cmd.args([
            format!("-Djava.library.path={}", natives_str),
            "-Dminecraft.launcher.brand=canger".into(),
            "-Dminecraft.launcher.version=0.1.0".into(),
        ]);
    } else {
        for jvm_arg in jvm_args_from_json {
            let resolved = jvm_arg
                .replace("${natives_directory}", &natives_str)
                .replace("${launcher_name}", "canger")
                .replace("${launcher_version}", "0.1.0")
                .replace("${classpath}", &classpath);
            cmd.arg(resolved);
        }
    }

    cmd.arg("-cp");
    cmd.arg(classpath);
    cmd.arg(main_class);

    let protected_options = [
        "--username",
        "--version",
        "--gameDir",
        "--assetsDir",
        "--assetIndex",
        "--uuid",
        "--accessToken",
        "--userType",
        "--versionType",
    ];
    let mut skip_next = false;
    for argument in &game_args_from_json {
        if skip_next {
            skip_next = false;
            continue;
        }
        if protected_options.contains(&argument.as_str()) {
            skip_next = true;
            continue;
        }
        if protected_options
            .iter()
            .any(|option| argument.starts_with(&format!("{}=", option)))
        {
            continue;
        }
        let resolved = argument
            .replace("${auth_player_name}", &nickname)
            .replace("${version_name}", &version_name)
            .replace("${game_directory}", &instance_dir.to_string_lossy())
            .replace("${assets_root}", &assets_dir.to_string_lossy())
            .replace("${game_assets}", &assets_dir.to_string_lossy())
            .replace("${assets_index_name}", &asset_index)
            .replace("${auth_uuid}", &uuid)
            .replace("${auth_access_token}", "0")
            .replace("${auth_session}", "0")
            .replace("${user_type}", "legacy")
            .replace("${version_type}", "release")
            .replace("${user_properties}", "{}")
            .replace("${clientid}", "")
            .replace("${auth_xuid}", "")
            .replace("${library_directory}", &libraries_dir.to_string_lossy());
        cmd.arg(resolved);
    }

    cmd.args([
        "--username".into(),
        nickname,
        "--version".into(),
        version_name.clone(),
        "--gameDir".into(),
        instance_dir.to_string_lossy().to_string(),
        "--assetsDir".into(),
        assets_dir.to_string_lossy().to_string(),
        "--assetIndex".into(),
        asset_index,
        "--uuid".into(),
        uuid,
        "--accessToken".into(),
        "0".into(),
        "--userType".into(),
        "legacy".into(),
        "--versionType".into(),
        "release".into(),
    ]);

    cmd.current_dir(&instance_dir);
    let logs_dir = instance_dir.join("logs");
    ensure_directory_no_follow(&logs_dir)
        .map_err(|e| format!("Failed to create version logs directory: {}", e))?;
    let (log_path, log_out) = create_unique_file_no_follow(&logs_dir, "launch-", ".log")
        .map_err(|e| format!("Не удалось создать лог запуска: {}", e))?;
    let log_err = log_out
        .try_clone()
        .map_err(|e| format!("Не удалось создать лог запуска: {}", e))?;
    cmd.stdout(std::process::Stdio::from(log_out));
    cmd.stderr(std::process::Stdio::from(log_err));
    eprintln!("[launch] cmd: {:?}", cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Не удалось запустить Java: {}", e))?;
    let pid = child.id();
    eprintln!("[launch] spawned pid={}, log={}", pid, log_path.display());

    let read_log = |path: &PathBuf| -> String { fs::read_to_string(path).unwrap_or_default() };
    for _ in 0..6 {
        thread::sleep(Duration::from_millis(500));
        match child.try_wait() {
            Ok(Some(status)) => {
                let err_msg = read_log(&log_path);
                eprintln!(
                    "[launch] game exited early, code={:?}\n--- log ---\n{}\n--- end ---",
                    status.code(),
                    err_msg
                        .lines()
                        .rev()
                        .take(40)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<Vec<_>>()
                        .join("\n")
                );

                if status.success() {
                    return Err("Игра запустилась и сразу завершилась. Возможно повреждены файлы — перекачайте версию.".into());
                }

                if err_msg.contains("UnsupportedClassVersionError") {
                    return Err(format!(
                        "Версия {} требует Java {}, а найденная версия не подходит.",
                        version_name, required_major
                    ));
                }

                if err_msg.contains("Unsupported class file major version 69") {
                    return Err(format!(
                        "Fabric Loader не поддерживает снапшоты Java 25 (26.x). Запустите Vanilla {} или Fabric 1.21.4.",
                        version_name
                    ));
                }

                let meaningful: Vec<&str> = err_msg
                    .lines()
                    .filter(|l| {
                        let t = l.trim();
                        t.contains("Exception")
                            || t.contains("Error")
                            || t.contains("Caused by")
                            || t.contains("Could not")
                            || t.contains("Failed")
                            || t.contains("at ")
                    })
                    .take(6)
                    .collect();

                if !meaningful.is_empty() {
                    return Err(format!("Ошибка запуска игры:\n{}", meaningful.join("\n")));
                }

                if !err_msg.trim().is_empty() {
                    let last_lines: Vec<&str> = err_msg.lines().rev().take(6).collect();
                    let ordered: Vec<&str> = last_lines.into_iter().rev().collect();
                    return Err(format!(
                        "Игра завершилась (код {:?}):\n{}",
                        status.code(),
                        ordered.join("\n")
                    ));
                }

                return Err(format!(
                    "Игра завершилась с ошибкой (код {:?}), лог пуст. Проверьте {}.",
                    status.code(),
                    log_path.display()
                ));
            }
            Ok(None) => {}
            Err(e) => {
                return Err(format!("Ошибка проверки процесса: {}", e));
            }
        }
    }

    let app_clone = app.clone();
    let ver_clone = version_name.clone();
    let log_path_bg = log_path.clone();
    thread::spawn(move || {
        let _version_run_guard = version_run_guard;
        let _version_process_lock = version_process_lock;
        loop {
            thread::sleep(Duration::from_secs(2));
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        let err_msg = fs::read_to_string(&log_path_bg).unwrap_or_default();
                        let meaningful: Vec<&str> = err_msg
                            .lines()
                            .filter(|l| {
                                let t = l.trim();
                                t.contains("Exception")
                                    || t.contains("Error")
                                    || t.contains("Caused by")
                            })
                            .take(3)
                            .collect();
                        let crash_msg = if !meaningful.is_empty() {
                            format!("{} упала: {}", ver_clone, meaningful.join(" | "))
                        } else {
                            format!(
                                "{} завершилась с ошибкой (код {:?})",
                                ver_clone,
                                status.code()
                            )
                        };
                        let _ = app_clone.emit("game-crashed", crash_msg);
                    }
                    return;
                }
                Ok(None) => {}
                Err(_) => return,
            }
        }
    });

    Ok(format!("Игра запущена (PID: {})", pid))
}

#[derive(Clone, Serialize, Deserialize)]
struct InstalledModInfo {
    name: String,
    filename: String,
    size: u64,
    enabled: bool,
}

fn canonical_mods_dir(game_dir: &Path) -> PathBuf {
    game_dir.join("mods")
}

fn mods_dir_for(version: &str) -> Result<PathBuf, String> {
    let game_dir = version_game_dir(&get_minecraft_dir(), version)?;
    let mods_dir = canonical_mods_dir(&game_dir);
    ensure_directory_no_follow(&mods_dir)?;
    Ok(mods_dir)
}

#[tauri::command]
fn get_installed_mods(version: String) -> Result<Vec<InstalledModInfo>, String> {
    let mods_dir = mods_dir_for(&version)?;
    let metadata = fs::symlink_metadata(&mods_dir)
        .map_err(|error| format!("Не удалось прочитать папку модов: {}", error))?;
    if is_link_metadata(&metadata) || !metadata.is_dir() {
        return Err("Путь модов не является безопасной папкой".into());
    }

    let mut list = Vec::new();
    let entries = fs::read_dir(&mods_dir)
        .map_err(|error| format!("Не удалось прочитать папку модов: {}", error))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Не удалось прочитать файл мода: {}", error))?;
        if file_type.is_file() && !file_type.is_symlink() {
            let filename = entry.file_name().to_string_lossy().to_string();
            let lower = filename.to_lowercase();
            if lower.ends_with(".jar") || lower.ends_with(".jar.disabled") {
                let enabled = lower.ends_with(".jar");
                let size = fs::symlink_metadata(&path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                let name = if enabled {
                    filename
                        .strip_suffix(".jar")
                        .unwrap_or(&filename)
                        .to_string()
                } else {
                    filename
                        .strip_suffix(".jar.disabled")
                        .unwrap_or(&filename)
                        .to_string()
                };
                list.push(InstalledModInfo {
                    name,
                    filename,
                    size,
                    enabled,
                });
            }
        }
    }
    list.sort_by_key(|item| item.name.to_lowercase());
    Ok(list)
}

#[tauri::command]
fn toggle_mod(filename: String, enable: bool, version: String) -> Result<String, String> {
    validate_mod_filename(&filename)?;
    let mods_dir = mods_dir_for(&version)?;
    let current_path = mods_dir.join(&filename);
    let current_metadata = fs::symlink_metadata(&current_path)
        .map_err(|error| format!("Не удалось прочитать файл мода: {}", error))?;
    if is_link_metadata(&current_metadata) || !current_metadata.is_file() {
        return Err("Refusing to modify a non-regular mod file".into());
    }

    let new_filename = if enable {
        if filename.ends_with(".jar.disabled") {
            filename.strip_suffix(".disabled").unwrap().to_string()
        } else {
            filename.clone()
        }
    } else {
        if filename.ends_with(".jar") {
            format!("{}.disabled", filename)
        } else {
            filename.clone()
        }
    };

    let target_path = mods_dir.join(&new_filename);
    if current_path != target_path {
        if let Ok(metadata) = fs::symlink_metadata(&target_path) {
            if is_link_metadata(&metadata) {
                return Err("Refusing to replace a symlink mod file".into());
            }
        }
        fs::rename(&current_path, &target_path)
            .map_err(|e| format!("Не удалось переименовать файл: {}", e))?;
    }

    Ok(new_filename)
}

#[tauri::command]
fn delete_mod(filename: String, version: String) -> Result<(), String> {
    validate_mod_filename(&filename)?;
    let mods_dir = mods_dir_for(&version)?;
    let file_path = mods_dir.join(&filename);
    let metadata = fs::symlink_metadata(&file_path)
        .map_err(|error| format!("Не удалось прочитать файл мода: {}", error))?;
    if is_link_metadata(&metadata) || !metadata.is_file() {
        return Err("Refusing to delete a non-regular mod file".into());
    }
    remove_file_no_follow(&file_path)
        .map_err(|error| format!("Не удалось удалить файл {}: {}", filename, error))?;
    Ok(())
}

#[tauri::command]
fn open_mods_folder(version: String) -> Result<(), String> {
    let mods_dir = mods_dir_for(&version)?;
    ensure_directory_no_follow(&mods_dir)?;
    open_in_file_manager(&mods_dir, false)
}

#[tauri::command]
fn open_minecraft_folder() -> Result<(), String> {
    let mc_dir = get_minecraft_dir();
    ensure_directory_no_follow(&mc_dir)?;
    open_in_file_manager(&mc_dir, false)
}

fn has_integrity_metadata(sha1: Option<&str>, sha512: Option<&str>) -> bool {
    sha1.is_some_and(|value| !value.trim().is_empty())
        || sha512.is_some_and(|value| !value.trim().is_empty())
}

#[tauri::command]
async fn install_mod_file(
    url: String,
    filename: String,
    version: String,
    sha1: Option<String>,
    sha512: Option<String>,
) -> Result<String, String> {
    validate_mod_filename(&filename)?;
    validate_url(&url)?;
    if !has_integrity_metadata(sha1.as_deref(), sha512.as_deref()) {
        return Err("Для мода отсутствует обязательный SHA-1 или SHA-512 checksum".into());
    }

    let mods_dir = mods_dir_for(&version)?;
    let dest = mods_dir.join(&filename);

    let client = build_http_client(Duration::from_secs(10))?;
    let head_resp = client
        .head(&url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to check file size: {}", e))?;
    if !head_resp.status().is_success() {
        return Err(format!("Mod download rejected: {}", head_resp.status()));
    }

    let content_length = head_resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);

    const MAX_MOD_SIZE: u64 = 100 * 1024 * 1024;
    if content_length > MAX_MOD_SIZE {
        return Err(format!(
            "Mod file too large: {} MB (max 100 MB)",
            content_length / 1024 / 1024
        ));
    }

    download_file_http_limited_with_expected_size(
        &url,
        &dest,
        MAX_MOD_SIZE,
        (content_length > 0).then_some(content_length),
    )
    .await?;

    if let Some(expected_hash) = sha1.as_deref() {
        if let Err(error) = verify_sha1(&dest, expected_hash) {
            let _ = remove_file_no_follow(&dest);
            return Err(error);
        }
    }
    if let Some(expected_hash) = sha512.as_deref() {
        if let Err(error) = verify_sha512(&dest, expected_hash) {
            let _ = remove_file_no_follow(&dest);
            return Err(error);
        }
    }

    let mut magic = [0u8; 4];
    {
        use std::io::Read;
        let mut file = open_regular_file_no_follow(&dest)
            .map_err(|error| format!("Не удалось открыть скачанный мод: {}", error))?;
        file.read_exact(&mut magic)
            .map_err(|e| format!("Скачанный файл мода слишком мал: {}", e))?;
    }
    if &magic != b"PK\x03\x04" && &magic != b"PK\x05\x06" && &magic != b"PK\x07\x08" {
        let _ = remove_file_no_follow(&dest);
        return Err("Скачанный файл не является JAR/ZIP".into());
    }

    let metadata = fs::symlink_metadata(&dest)
        .map_err(|error| format!("Скачанный файл мода недоступен: {}", error))?;
    if is_link_metadata(&metadata) || !metadata.is_file() || metadata.len() == 0 {
        return Err("Скачанный файл мода пуст или поврежден".into());
    }

    Ok(filename)
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DirItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command]
fn list_dir_contents(subpath: Option<String>, version: String) -> Result<Vec<DirItem>, String> {
    let mc_dir = resolve_game_dir(&version)?;
    let is_root = match &subpath {
        None => true,
        Some(s) => s.trim().trim_matches(&['/', '\\'][..]).is_empty(),
    };

    let target = if is_root {
        let standard = [
            "mods",
            "resourcepacks",
            "shaderpacks",
            "saves",
            "screenshots",
            "config",
            "logs",
        ];
        for s in standard {
            let _ = fs::create_dir_all(mc_dir.join(s));
        }
        mc_dir.clone()
    } else if let Some(ref sub) = subpath {
        validate_subpath(&mc_dir, sub)?
    } else {
        mc_dir.clone()
    };

    if !target.exists() {
        let _ = fs::create_dir_all(&target);
    }

    let entries =
        fs::read_dir(&target).map_err(|e| format!("Не удалось прочитать папку: {}", e))?;
    let mut items = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') && name != ".minecraft" {
            continue;
        }

        let metadata = match entry.path().symlink_metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if is_link_metadata(&metadata) {
            continue;
        }
        let is_dir = metadata.is_dir();
        let size = if is_dir { 0 } else { metadata.len() };

        let rel = match path.strip_prefix(&mc_dir) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => name.clone(),
        };

        items.push(DirItem {
            name,
            path: rel,
            is_dir,
            size,
        });
    }

    items.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(items)
}

#[tauri::command]
fn open_game_path(relative_path: Option<String>, version: String) -> Result<(), String> {
    let mc_dir = resolve_game_dir(&version)?;
    let path = if let Some(sub) = relative_path {
        validate_subpath(&mc_dir, &sub)?
    } else {
        mc_dir.clone()
    };

    if !path.exists() {
        return Err("Путь не существует".into());
    }

    open_in_file_manager(&path, path.is_file())
}

fn is_protected_version_path(version_id: &str, relative_path: &str) -> bool {
    let normalized = relative_path
        .replace('\\', "/")
        .trim_matches('/')
        .to_ascii_lowercase();
    let first_component = normalized.split('/').next().unwrap_or_default();
    if matches!(
        first_component,
        "natives" | "assets" | "libraries" | "versions" | "canger"
    ) {
        return true;
    }
    let version = version_id.to_ascii_lowercase();
    first_component == format!("{version}.json")
        || first_component == format!("{version}.jar")
        || first_component == "vanilla.json"
}

#[tauri::command]
fn delete_game_path(relative_path: String, version: String) -> Result<(), String> {
    let mc_dir = resolve_game_dir(&version)?;
    let trimmed = relative_path.trim().trim_matches(&['/', '\\'][..]);
    if trimmed.is_empty() {
        return Err("Нельзя удалить корень .minecraft".into());
    }
    if is_protected_version_path(&version, trimmed) {
        return Err("Служебные файлы и папки версии удалить нельзя".into());
    }

    let target = validate_subpath(&mc_dir, trimmed)?;
    ensure_no_symlink_in_existing_ancestors(&target)?;
    if !target.exists() {
        return Err("Файл или папка не найдены".into());
    }

    remove_tree_no_follow(&target)
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fn copy_bounded(src: &Path, dst: &Path, depth: u8, copied: &mut u64) -> std::io::Result<()> {
        if depth > 32 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "directory nesting is too deep",
            ));
        }
        if let Ok(metadata) = fs::symlink_metadata(dst) {
            if is_link_metadata(&metadata) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "destination contains a symbolic link",
                ));
            }
        }
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let ty = entry.file_type()?;
            if ty.is_symlink() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "symbolic links are not allowed during import",
                ));
            }
            let target = dst.join(entry.file_name());
            if ty.is_dir() {
                copy_bounded(&entry.path(), &target, depth + 1, copied)?;
            } else {
                let size = entry.metadata()?.len();
                *copied = copied.saturating_add(size);
                if *copied > 4 * 1024 * 1024 * 1024 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "import exceeds the 4 GiB safety limit",
                    ));
                }
                fs::copy(entry.path(), target)?;
            }
        }
        Ok(())
    }

    let mut copied = 0u64;
    copy_bounded(src, dst, 0, &mut copied)
}

#[tauri::command]
fn import_game_files(
    source_paths: Vec<String>,
    target_subpath: Option<String>,
    version: String,
) -> Result<Vec<String>, String> {
    let mc_dir = resolve_game_dir(&version)?;
    let dest_dir = if let Some(sub) = target_subpath {
        let path = validate_subpath(&mc_dir, &sub)?;
        if is_protected_version_path(&version, &sub) {
            return Err("Служебные файлы и папки версии изменять нельзя".into());
        }
        path
    } else {
        mc_dir.clone()
    };

    if !dest_dir.exists() {
        fs::create_dir_all(&dest_dir)
            .map_err(|e| format!("Не удалось создать папку назначения: {}", e))?;
    }

    if source_paths.len() > 256 {
        return Err("Too many imported paths (maximum 256)".into());
    }
    let mut imported = Vec::new();

    for src_str in source_paths {
        let src_path = PathBuf::from(&src_str);
        if !src_path.exists() {
            continue;
        }

        let file_name = match src_path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        validate_safe_component(&file_name, "imported file name")?;
        let source_metadata = fs::symlink_metadata(&src_path)
            .map_err(|error| format!("Failed to inspect imported path: {}", error))?;
        if is_link_metadata(&source_metadata) {
            return Err(format!("Symbolic links are not allowed: {}", file_name));
        }

        let target_file = dest_dir.join(&file_name);
        let target_relative = target_file
            .strip_prefix(&mc_dir)
            .map_err(|_| "Invalid import destination".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if is_protected_version_path(&version, &target_relative) {
            return Err("Служебные файлы и папки версии изменять нельзя".into());
        }
        if target_file.exists() {
            let target_metadata =
                fs::symlink_metadata(&target_file).map_err(|error| error.to_string())?;
            if is_link_metadata(&target_metadata) {
                return Err(format!("Refusing to overwrite symlink: {}", file_name));
            }
            if !target_metadata.is_dir() {
                continue;
            }
        }

        if source_metadata.is_dir() {
            copy_dir_all(&src_path, &target_file)
                .map_err(|e| format!("Ошибка копирования папки {}: {}", file_name, e))?;
        } else {
            fs::copy(&src_path, &target_file)
                .map_err(|e| format!("Ошибка копирования файла {}: {}", file_name, e))?;
        }

        imported.push(file_name);
    }

    Ok(imported)
}

const MAX_PACK_OVERRIDE_BYTES: usize = 8 * 1024 * 1024;

#[tauri::command]
fn write_game_file(
    relative_path: String,
    contents_base64: String,
    version: String,
) -> Result<String, String> {
    use base64::Engine;

    let mc_dir = resolve_game_dir(&version)?;
    let clean = relative_path.trim().trim_matches(&['/', '\\'][..]);
    if clean.is_empty() {
        return Err("Путь файла не указан".into());
    }
    if is_protected_version_path(&version, clean) {
        return Err("Служебные файлы и папки версии изменять нельзя".into());
    }
    if clean.split(['/', '\\']).count() > 16 {
        return Err("Слишком глубокий путь файла".into());
    }
    let dest = validate_subpath(&mc_dir, clean)?;
    if let Some(parent) = dest.parent() {
        ensure_directory_no_follow(parent)?;
    }
    if contents_base64.len() > MAX_PACK_OVERRIDE_BYTES.saturating_mul(2) {
        return Err("Файл сборки превышает допустимый размер".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_base64.as_bytes())
        .map_err(|error| format!("Некорректные данные файла: {}", error))?;
    if bytes.len() > MAX_PACK_OVERRIDE_BYTES {
        return Err("Файл сборки превышает допустимый размер".into());
    }
    if fs::symlink_metadata(&dest)
        .map(|metadata| is_link_metadata(&metadata))
        .unwrap_or(false)
    {
        return Err("Отказ в записи через символическую ссылку".into());
    }
    let temp = temporary_download_path(&dest);
    fs::write(&temp, &bytes).map_err(|error| format!("Ошибка записи файла: {}", error))?;
    if let Err(error) = commit_download(&temp, &dest) {
        let _ = remove_file_no_follow(&temp);
        return Err(format!("Ошибка сохранения файла: {}", error));
    }
    Ok(clean.to_string())
}

#[tauri::command]
fn move_game_path(
    source_subpath: String,
    target_subpath: Option<String>,
    version: String,
) -> Result<(), String> {
    let mc_dir = resolve_game_dir(&version)?;
    let src_clean = source_subpath.trim().trim_matches(&['/', '\\'][..]);
    if src_clean.is_empty() {
        return Err("Нельзя переместить корневую папку".into());
    }
    if is_protected_version_path(&version, src_clean) {
        return Err("Служебные файлы и папки версии изменять нельзя".into());
    }
    let src = validate_subpath(&mc_dir, src_clean)?;
    if !src.exists() {
        return Err("Исходный файл или папка не найден(а)".into());
    }

    let dest_dir = if let Some(sub) = target_subpath {
        validate_subpath(&mc_dir, &sub)?
    } else {
        mc_dir.clone()
    };

    if !dest_dir.exists() {
        fs::create_dir_all(&dest_dir)
            .map_err(|e| format!("Не удалось создать целевую папку: {}", e))?;
    }

    let file_name = match src.file_name() {
        Some(n) => n,
        None => return Err("Недопустимое имя файла".into()),
    };

    let target = dest_dir.join(file_name);
    let target_relative = target
        .strip_prefix(&mc_dir)
        .map_err(|_| "Invalid move destination".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    if is_protected_version_path(&version, &target_relative) {
        return Err("Служебные файлы и папки версии изменять нельзя".into());
    }
    if target.exists() {
        let metadata = fs::symlink_metadata(&target).map_err(|error| error.to_string())?;
        if is_link_metadata(&metadata) {
            return Err("Нельзя переместить файл поверх символической ссылки".into());
        }
    }

    if src == target {
        return Ok(());
    }
    if target.starts_with(&src) {
        return Err("Нельзя переместить папку саму в себя".into());
    }

    if fs::rename(&src, &target).is_err() {
        if src.is_dir() {
            copy_dir_all(&src, &target).map_err(|e| format!("Ошибка копирования папки: {}", e))?;
            fs::remove_dir_all(&src)
                .map_err(|e| format!("Ошибка удаления исходной папки: {}", e))?;
        } else {
            fs::copy(&src, &target).map_err(|e| format!("Ошибка копирования файла: {}", e))?;
            fs::remove_file(&src).map_err(|e| format!("Ошибка удаления исходного файла: {}", e))?;
        }
    }

    Ok(())
}

#[tauri::command]
fn open_game_folder(subfolder: Option<String>, version: String) -> Result<(), String> {
    open_game_path(subfolder, version)
}

#[tauri::command]
async fn fetch_curseforge_api(endpoint: String, method: Option<String>) -> Result<String, String> {
    if endpoint.contains("://")
        || endpoint.contains('\\')
        || endpoint.split('/').any(|part| part == "..")
    {
        return Err("CurseForge endpoint must be a relative API path".into());
    }
    let api_key = resolve_curseforge_key().ok_or_else(|| {
        "CurseForge API key is not configured. Set it in Launcher settings or via CANGER_CURSEFORGE_API_KEY."
            .to_string()
    })?;
    if api_key.trim().is_empty() {
        return Err("CurseForge API key is empty".into());
    }

    let method = method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    if method != "GET" && method != "POST" {
        return Err("CurseForge method must be GET or POST".into());
    }
    let request_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("Invalid HTTP method: {}", e))?;
    let url = format!(
        "https://api.curseforge.com/v1/{}",
        endpoint.trim_start_matches('/')
    );
    validate_url(&url)?;

    let client = build_http_client(Duration::from_secs(30))?;
    let response = client
        .request(request_method, &url)
        .header("x-api-key", api_key)
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("CurseForge API request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("CurseForge API error: {}", response.status()));
    }
    const MAX_CF_RESPONSE: u64 = 10 * 1024 * 1024;
    if response.content_length().unwrap_or(0) > MAX_CF_RESPONSE {
        return Err("CurseForge response exceeds the 10 MiB safety limit".into());
    }
    use futures_util::StreamExt;
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Failed to read CurseForge response: {}", e))?;
        if body.len() as u64 + chunk.len() as u64 > MAX_CF_RESPONSE {
            return Err("CurseForge response exceeds the 10 MiB safety limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| "CurseForge returned non-UTF-8 data".into())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_installed_versions,
            download_version,
            get_forge_promotions,
            get_forge_versions,
            get_neoforge_versions,
            install_forge,
            install_neoforge,
            launch_game,
            get_installed_mods,
            toggle_mod,
            delete_mod,
            open_mods_folder,
            open_minecraft_folder,
            open_game_folder,
            open_game_path,
            list_dir_contents,
            delete_game_path,
            import_game_files,
            write_game_file,
            move_game_path,
            install_mod_file,
            fetch_curseforge_api
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn java_candidate_requires_the_declared_major() {
        let candidates = vec![
            (8, PathBuf::from("java8")),
            (17, PathBuf::from("java17")),
            (21, PathBuf::from("java21")),
        ];
        assert_eq!(
            choose_java_candidate(&candidates, 8),
            Some(PathBuf::from("java8"))
        );
        assert_eq!(
            choose_java_candidate(&candidates, 17),
            Some(PathBuf::from("java17"))
        );
        assert_eq!(choose_java_candidate(&candidates, 25), None);
    }

    #[test]
    fn mod_install_requires_integrity_metadata() {
        assert!(!has_integrity_metadata(None, None));
        assert!(!has_integrity_metadata(Some(""), Some(" ")));
        assert!(has_integrity_metadata(Some("abc"), None));
        assert!(has_integrity_metadata(None, Some("abc")));
    }

    #[test]
    fn test_offline_uuid() {
        assert_eq!(
            offline_uuid("Steve"),
            "5627dd98-e6be-3c21-b8a8-e92344183641"
        );
    }

    #[test]
    fn version_metadata_accepts_current_mojang_package_urls() {
        assert!(validate_version_metadata_url(
            "https://piston-meta.mojang.com/v1/packages/6485dd131ef68c968041a9f6fd73094b027e42e1/1.16.3.json",
            false,
        )
        .is_ok());
        assert!(validate_version_metadata_url(
            "https://piston-meta.mojang.com/mc/game/1.16.3.json",
            false,
        )
        .is_ok());
        assert!(validate_version_metadata_url(
            "https://piston-meta.mojang.com/v1/packages/not-json",
            false,
        )
        .is_err());
        assert!(validate_version_metadata_url(
            "https://piston-meta.mojang.com.evil.example/v1/packages/hash/1.16.3.json",
            false,
        )
        .is_err());
    }

    #[test]
    fn download_urls_use_exact_https_hosts() {
        for valid in [
            "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
            "https://maven.minecraftforge.net/artifact.jar",
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.251/neoforge-21.1.251-installer.jar",
            "https://neoforged.forgecdn.net/releases/net/neoforged/fancymodloader/loader/4.0.41/loader-4.0.41.jar",
            "https://api.adoptium.net/v3/assets/latest/17",
        ] {
            assert!(validate_url(valid).is_ok(), "rejected {valid}");
        }
        for invalid in [
            "http://piston-meta.mojang.com/manifest.json",
            "https://api.modrinth.com.evil.example/file",
            "https://evil.example/?next=https://api.modrinth.com/file",
            "https://user:password@api.modrinth.com/file",
            "https://api.modrinth.com:444/file",
        ] {
            assert!(validate_url(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn fabric_version_requirements_cover_common_ranges() {
        assert!(version_requirement_matches("26.3", "~26.3-"));
        assert!(version_requirement_matches("26.3.1", "26.3.x"));
        assert!(version_requirement_matches("26.3", ">=26.3 <26.4"));
        assert!(!version_requirement_matches("1.21.1", "~26.3-"));
        assert!(!version_requirement_matches("21", ">=25"));
        assert_eq!(
            first_minecraft_version_token("1.21.1-fabric"),
            Some("1.21.1".to_string())
        );
        assert_eq!(
            first_minecraft_version_token("26.3-66.0.3"),
            Some("26.3".to_string())
        );
    }

    #[test]
    fn local_only_forge_library_is_kept_for_classpath() {
        let json = serde_json::json!({
            "libraries": [{
                "name": "net.minecraftforge:forge:26.3-66.0.3:client",
                "downloads": {
                    "artifact": {
                        "path": "net/minecraftforge/forge/26.3-66.0.3/forge-26.3-66.0.3-client.jar",
                        "url": "",
                        "sha1": "be5b84fffb29ab73261998c491d6e0871faf303c",
                        "size": 82957720
                    }
                }
            }]
        });
        let libraries = parse_libraries_from_json(&json, Path::new("libraries"));
        assert_eq!(libraries.len(), 1);
        assert!(libraries[0].url.is_empty());
        assert!(libraries[0].dest.ends_with("forge-26.3-66.0.3-client.jar"));
    }

    #[test]
    fn legacy_native_classifiers_are_kept_with_base_library() {
        let os_key = if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "osx"
        } else {
            "linux"
        };
        let arch_num = if cfg!(target_arch = "x86_64") {
            "64"
        } else {
            "32"
        };
        let classifier_key = format!("natives-{os_key}-{arch_num}");
        let mut classifiers = serde_json::Map::new();
        classifiers.insert(
            classifier_key,
            serde_json::json!({
                "path": format!("org/lwjgl/lwjgl/1.0/lwjgl-{arch_num}.jar"),
                "url": "https://libraries.minecraft.net/org/lwjgl/lwjgl/1.0/lwjgl.jar",
                "sha1": "0123456789012345678901234567890123456789"
            }),
        );
        let mut natives = serde_json::Map::new();
        natives.insert(
            os_key.to_string(),
            serde_json::Value::String(format!("natives-{os_key}-${{arch}}")),
        );
        let json = serde_json::json!({
            "libraries": [{
                "name": "org.lwjgl.lwjgl:lwjgl:1.0",
                "natives": serde_json::Value::Object(natives),
                "downloads": {
                    "artifact": {
                        "path": "org/lwjgl/lwjgl/1.0/lwjgl.jar",
                        "url": "https://libraries.minecraft.net/org/lwjgl/lwjgl/1.0/lwjgl.jar",
                        "sha1": "0123456789012345678901234567890123456789"
                    },
                    "classifiers": serde_json::Value::Object(classifiers)
                }
            }]
        });
        let libraries = parse_libraries_from_json(&json, Path::new("libraries"));
        assert!(has_legacy_native_metadata(&json));
        assert_eq!(libraries.len(), 2);
        assert_eq!(libraries.iter().filter(|item| item.is_native).count(), 1);
        assert!(libraries
            .iter()
            .any(|item| item.dest.ends_with("lwjgl.jar")));
    }

    #[test]
    fn maven_metadata_versions_are_extracted_without_xml_noise() {
        let metadata = "<metadata><versioning><versions><version>21.1.251</version><version>26.2.0.88</version><version>bad version</version></versions></versioning></metadata>";
        assert_eq!(
            parse_maven_metadata_versions(metadata),
            vec!["21.1.251".to_string(), "26.2.0.88".to_string()]
        );
    }

    #[test]
    fn version_internal_files_are_protected_from_folder_manager() {
        assert!(is_protected_version_path(
            "1.21.1-fabric",
            "1.21.1-fabric.json"
        ));
        assert!(is_protected_version_path(
            "1.21.1-fabric",
            "natives/lwjgl.dll"
        ));
        assert!(is_protected_version_path("1.21.1-fabric", "vanilla.json"));
        assert!(!is_protected_version_path(
            "1.21.1-fabric",
            "mods/example.jar"
        ));
        assert!(!is_protected_version_path(
            "1.21.1-fabric",
            "saves/world/level.dat"
        ));
    }

    #[test]
    fn installed_versions_sort_newest_first_and_deterministically() {
        let mut ids = [
            "1.16.5-forge-36.2.34".to_string(),
            "26.3-forge-66.0.3".to_string(),
            "1.21.1-fabric".to_string(),
            "1.20.1".to_string(),
            "26.3".to_string(),
            "26.3-fabric".to_string(),
            "1.8.9".to_string(),
        ];
        ids.sort();
        ids.sort_by(|left, right| {
            let (left_key, left_name) = version_sort_key(left);
            let (right_key, right_name) = version_sort_key(right);
            right_key
                .cmp(&left_key)
                .then_with(|| left_name.cmp(&right_name))
        });
        assert_eq!(ids[0], "26.3");
        assert_eq!(ids[1], "26.3-fabric");
        assert_eq!(ids[2], "26.3-forge-66.0.3");
        assert_eq!(ids.last().map(String::as_str), Some("1.8.9"));
    }

    #[test]
    fn curseforge_key_format_is_validated() {
        assert!(is_valid_curseforge_key("abcd1234-EFGH_5678"));
        assert!(!is_valid_curseforge_key(""));
        assert!(!is_valid_curseforge_key("has space"));
        assert!(!is_valid_curseforge_key("quote\"injection"));
        assert!(!is_valid_curseforge_key(&"a".repeat(257)));
    }

    #[test]
    fn os_rule_versions_support_mojang_prefix_patterns() {
        assert!(os_version_pattern_matches("^10\\.", Some("10.0.19045")));
        assert!(os_version_pattern_matches("10.0", Some("10.0.19045")));
        assert!(!os_version_pattern_matches("^6\\.", Some("10.0.19045")));
        assert!(os_version_pattern_matches("^6\\.", None));
    }

    #[test]
    fn renderer_file_names_cannot_escape_their_roots() {
        for invalid in [
            "../outside.jar",
            "..\\outside.jar",
            "C:\\outside.jar",
            "/absolute.jar",
            "mod.jar/child",
            "CON.jar",
            "not-a-jar.txt",
        ] {
            assert!(
                validate_mod_filename(invalid).is_err(),
                "accepted {invalid}"
            );
        }
        assert!(validate_mod_filename("Sodium-fabric-0.6.0.jar").is_ok());
    }

    #[test]
    fn game_subpaths_reject_root_aliases_and_parent_traversal() {
        let root = std::env::temp_dir().join(format!(
            "canger-path-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("mods")).expect("create test root");
        assert!(validate_subpath(&root, "mods").is_ok());
        for invalid in [".", "./", "..", "../outside", "mods/../../outside"] {
            assert!(
                validate_subpath(&root, invalid).is_err(),
                "accepted {invalid}"
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    fn test_directory(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "canger-java-test-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("create test directory");
        path
    }

    fn write_test_zip(path: &Path, entries: &[(&str, &[u8])]) {
        use std::io::Write;
        let file = fs::File::create(path).expect("create zip");
        let mut writer = zip::ZipWriter::new(file);
        let options =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            writer.start_file(*name, options).expect("start zip entry");
            writer.write_all(data).expect("write zip entry");
        }
        writer.finish().expect("finish zip");
    }

    fn write_test_tar_gz(path: &Path, entries: &[(&str, &[u8], tar::EntryType)]) {
        use std::io::Cursor;
        let file = fs::File::create(path).expect("create tar.gz");
        let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        for (name, data, entry_type) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(*entry_type);
            header.set_mode(0o755);
            header.set_size(if entry_type.is_file() {
                data.len() as u64
            } else {
                0
            });
            header.set_cksum();
            builder
                .append_data(&mut header, name, Cursor::new(*data))
                .expect("write tar entry");
        }
        let encoder = builder.into_inner().expect("finish tar");
        encoder.finish().expect("finish gzip");
    }

    #[test]
    fn adoptium_manifest_uses_current_feature_releases_binaries_schema() {
        let url = adoptium_feature_releases_url(17, "windows", "x64").unwrap();
        assert!(url.starts_with("https://api.adoptium.net/v3/assets/feature_releases/17/ga?"));
        assert!(url.contains("page=0&page_size=1"));

        let metadata = serde_json::json!([{
            "version_data": {"major": 17},
            "binaries": [{
                "architecture": "x64",
                "heap_size": "normal",
                "image_type": "jre",
                "jvm_impl": "hotspot",
                "os": "windows",
                "package": {
                    "name": "OpenJDK17U-jre_x64_windows_hotspot.zip",
                    "link": "https://github.com/adoptium/temurin17-binaries/releases/download/jdk/OpenJDK17U-jre_x64_windows_hotspot.zip",
                    "checksum": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                    "size": 1234
                }
            }]
        }]);
        let package =
            parse_adoptium_feature_releases(&metadata.to_string(), 17, "windows", "x64").unwrap();
        assert_eq!(package.kind, JavaArchiveKind::Zip);
        assert_eq!(package.size, 1234);
        assert_eq!(package.checksum.len(), 64);

        let linux_metadata = serde_json::json!([{
            "version_data": {"major": 17},
            "binaries": [{
                "architecture": "x64",
                "heap_size": "normal",
                "image_type": "jre",
                "jvm_impl": "hotspot",
                "os": "linux",
                "package": {
                    "name": "OpenJDK17U-jre_x64_linux_hotspot.tar.gz",
                    "link": "https://github.com/adoptium/temurin17-binaries/releases/download/jdk/OpenJDK17U-jre_x64_linux_hotspot.tar.gz",
                    "checksum": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                    "size": 1234
                }
            }]
        }]);
        assert_eq!(
            parse_adoptium_feature_releases(&linux_metadata.to_string(), 17, "linux", "x64")
                .unwrap()
                .kind,
            JavaArchiveKind::TarGz
        );
    }

    #[test]
    fn adoptium_manifest_rejects_legacy_shape_and_unsafe_package_metadata() {
        let legacy = serde_json::json!([{
            "version_data": {"major": 17},
            "binary": {"package": {
                "name": "java.zip",
                "link": "https://github.com/adoptium/java.zip",
                "checksum": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "size": 10
            }}
        }]);
        assert!(
            parse_adoptium_feature_releases(&legacy.to_string(), 17, "windows", "x64").is_err()
        );

        let base = |size: u64, checksum: &str, name: &str, link: &str| {
            serde_json::json!([{
                "version_data": {"major": 17},
                "binaries": [{
                    "architecture": "x64",
                    "heap_size": "normal",
                    "image_type": "jre",
                    "jvm_impl": "hotspot",
                    "os": "windows",
                    "package": {"name": name, "link": link, "checksum": checksum, "size": size}
                }]
            }])
        };
        let valid_hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let valid_link = "https://github.com/adoptium/java.zip";
        assert!(parse_adoptium_feature_releases(
            &base(0, valid_hash, "java.zip", valid_link).to_string(),
            17,
            "windows",
            "x64"
        )
        .is_err());
        assert!(parse_adoptium_feature_releases(
            &base(10, "not-a-hash", "java.zip", valid_link).to_string(),
            17,
            "windows",
            "x64"
        )
        .is_err());
        assert!(parse_adoptium_feature_releases(
            &base(
                10,
                valid_hash,
                "java.tar.gz",
                "https://github.com/adoptium/java.tar.gz"
            )
            .to_string(),
            17,
            "windows",
            "x64"
        )
        .is_err());
    }

    #[test]
    fn java_archives_extract_only_regular_files_and_safe_paths() {
        let root = test_directory("archives");
        let zip_path = root.join("java.zip");
        write_test_zip(
            &zip_path,
            &[
                ("jdk/bin/java", b"#!/bin/sh\n"),
                ("jdk/release", b"IMPLEMENTATION=test"),
            ],
        );
        let zip_out = root.join("zip-out");
        extract_java_archive(&zip_path, &zip_out, JavaArchiveKind::Zip).unwrap();
        assert_eq!(
            fs::read(zip_out.join("jdk/bin/java")).unwrap(),
            b"#!/bin/sh\n"
        );

        let tar_path = root.join("java.tar.gz");
        write_test_tar_gz(
            &tar_path,
            &[
                ("jdk/bin/java", b"#!/bin/sh\n", tar::EntryType::Regular),
                (
                    "jdk/release",
                    b"IMPLEMENTATION=test",
                    tar::EntryType::Regular,
                ),
            ],
        );
        let tar_out = root.join("tar-out");
        extract_java_archive(&tar_path, &tar_out, JavaArchiveKind::TarGz).unwrap();
        assert_eq!(
            fs::read(tar_out.join("jdk/bin/java")).unwrap(),
            b"#!/bin/sh\n"
        );

        assert!(safe_archive_relative_path("../outside").is_err());
        assert!(safe_archive_relative_path("/absolute").is_err());

        let link_archive = root.join("link.tar.gz");
        write_test_tar_gz(&link_archive, &[("jdk/link", b"", tar::EntryType::Symlink)]);
        assert!(extract_java_archive(
            &link_archive,
            &root.join("link-out"),
            JavaArchiveKind::TarGz
        )
        .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn version_game_dirs_keep_mods_isolated() {
        let root = test_directory("version-game-dirs");
        let fabric = version_game_dir(&root, "1.21.1-fabric").expect("fabric game dir");
        let forge = version_game_dir(&root, "1.20.1-forge-47.4.10").expect("forge game dir");
        assert_ne!(fabric, forge);
        assert_eq!(canonical_mods_dir(&fabric), fabric.join("mods"));
        assert_eq!(canonical_mods_dir(&forge), forge.join("mods"));
        assert!(fabric.join("mods").is_dir());
        assert!(forge.join("mods").is_dir());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn process_file_lock_is_exclusive_and_releases_with_guard() {
        let root = test_directory("lock");
        let path = root.join("profile.lock");
        let first = acquire_process_file_lock(&path).expect("first lock");
        assert!(acquire_process_file_lock(&path).is_err());
        drop(first);
        let second = acquire_process_file_lock(&path).expect("lock after release");
        drop(second);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn download_commit_refuses_to_follow_destination_symlink() {
        use std::os::unix::fs::symlink;
        let root = test_directory("symlink");
        let outside = root.join("outside.txt");
        fs::write(&outside, b"keep").unwrap();
        let destination = root.join("destination.jar");
        symlink(&outside, &destination).unwrap();
        let temporary = root.join("download.part");
        fs::write(&temporary, b"new").unwrap();
        assert!(commit_download(&temporary, &destination).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"keep");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_forge_game_arguments_and_required_placeholders_are_preserved() {
        let parsed = serde_json::json!({
            "minecraftArguments": "--username ${auth_player_name} --tweakClass cpw.mods.fml.common.launcher.FMLTweaker"
        });
        let arguments = collect_game_arguments(&parsed);
        assert!(arguments.contains(&"--tweakClass".to_string()));
        assert!(arguments.contains(&"cpw.mods.fml.common.launcher.FMLTweaker".to_string()));
        assert!(!is_safe_metadata_jvm_arg("-Xmx2G"));
        assert!(!is_safe_metadata_jvm_arg("-javaagent:evil.jar"));
        assert!(!is_safe_metadata_jvm_arg("-XX:OnOutOfMemoryError=calc.exe"));
    }
}
