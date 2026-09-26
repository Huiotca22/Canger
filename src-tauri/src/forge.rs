#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

pub const FORGE_MAVEN_BASE_URL: &str = "https://maven.minecraftforge.net";

pub const FORGE_PROMOTIONS_URL: &str =
    "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";

pub const FORGE_METADATA_URL: &str =
    "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml";

pub const NEOFORGE_MAVEN_BASE_URL: &str = "https://maven.neoforged.net/releases";

pub const NEOFORGE_VERSIONS_URL: &str =
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml";

pub const PROMOTIONS_SLIM_URL: &str = FORGE_PROMOTIONS_URL;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForgeChannel {
    Recommended,
    Latest,
    Explicit,
}

impl ForgeChannel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Recommended => "recommended",
            Self::Latest => "latest",
            Self::Explicit => "explicit",
        }
    }
}

impl fmt::Display for ForgeChannel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl PartialEq<str> for ForgeChannel {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == other
    }
}

impl PartialEq<&str> for ForgeChannel {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

impl PartialEq<String> for ForgeChannel {
    fn eq(&self, other: &String) -> bool {
        self.as_str() == other
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeBuild {
    pub minecraft_version: String,
    pub forge_version: String,
    pub full_forge_version: String,
    pub profile_id: String,
    pub channel: ForgeChannel,
    pub installer_url: String,
    pub installer_sha1_url: String,
}

impl ForgeBuild {
    pub fn new(
        minecraft_version: impl AsRef<str>,
        forge_version: impl AsRef<str>,
        channel: ForgeChannel,
    ) -> Result<Self, ForgeError> {
        let minecraft_version = minecraft_version.as_ref();
        let forge_version = forge_version.as_ref();

        validate_minecraft_version(minecraft_version)?;
        validate_forge_build(forge_version)?;

        let full_forge_version = full_forge_version(minecraft_version, forge_version)?;
        let profile_id = technical_profile_id(minecraft_version, forge_version)?;
        let (installer_url, installer_sha1_url) =
            forge_installer_urls(minecraft_version, forge_version)?;

        Ok(Self {
            minecraft_version: minecraft_version.to_owned(),
            forge_version: forge_version.to_owned(),
            full_forge_version,
            profile_id,
            channel,
            installer_url,
            installer_sha1_url,
        })
    }

    pub fn explicit(
        minecraft_version: impl AsRef<str>,
        forge_version: impl AsRef<str>,
    ) -> Result<Self, ForgeError> {
        Self::new(minecraft_version, forge_version, ForgeChannel::Explicit)
    }

    pub fn supports_headless_client_install(&self) -> bool {
        supports_headless_client_install(&self.minecraft_version)
    }

    pub fn ensure_headless_client_install_supported(&self) -> Result<(), ForgeError> {
        ensure_headless_client_install_supported(&self.minecraft_version)
    }

    pub fn validate(&self) -> Result<(), ForgeError> {
        validate_minecraft_version(&self.minecraft_version)?;
        validate_forge_build(&self.forge_version)?;

        let expected_full = full_forge_version(&self.minecraft_version, &self.forge_version)?;
        if self.full_forge_version != expected_full {
            return Err(ForgeError::ProfileValidation {
                detail: format!(
                    "fullForgeVersion must be {:?}, got {:?}",
                    expected_full, self.full_forge_version
                ),
            });
        }

        let expected_profile = technical_profile_id(&self.minecraft_version, &self.forge_version)?;
        if self.profile_id != expected_profile {
            return Err(ForgeError::ProfileValidation {
                detail: format!(
                    "profileId must be {:?}, got {:?}",
                    expected_profile, self.profile_id
                ),
            });
        }

        let (expected_installer, expected_sha1) =
            forge_installer_urls(&self.minecraft_version, &self.forge_version)?;
        assert_official_forge_maven_url(&self.installer_url)?;
        assert_official_forge_maven_url(&self.installer_sha1_url)?;
        if self.installer_url != expected_installer {
            return Err(ForgeError::InvalidForgeUrl {
                url: self.installer_url.clone(),
            });
        }
        if self.installer_sha1_url != expected_sha1 {
            return Err(ForgeError::InvalidForgeUrl {
                url: self.installer_sha1_url.clone(),
            });
        }

        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeInstallResult {
    pub minecraft_version: String,
    pub forge_version: String,
    pub full_forge_version: String,
    pub profile_id: String,
    pub channel: ForgeChannel,
    pub installer_url: String,
    pub installer_sha1_url: String,
    pub supports_headless_client_install: bool,
    pub profile_json_path: PathBuf,
    pub parent_json_path: PathBuf,
    pub parent_jar_path: PathBuf,
}

impl ForgeInstallResult {
    pub fn from_validated_profile(
        build: &ForgeBuild,
        profile_json_path: PathBuf,
        parent_json_path: PathBuf,
        parent_jar_path: PathBuf,
    ) -> Result<Self, ForgeError> {
        build.validate()?;
        build.ensure_headless_client_install_supported()?;

        Ok(Self {
            minecraft_version: build.minecraft_version.clone(),
            forge_version: build.forge_version.clone(),
            full_forge_version: build.full_forge_version.clone(),
            profile_id: build.profile_id.clone(),
            channel: build.channel,
            installer_url: build.installer_url.clone(),
            installer_sha1_url: build.installer_sha1_url.clone(),
            supports_headless_client_install: true,
            profile_json_path,
            parent_json_path,
            parent_jar_path,
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct ForgePromotions {
    entries: BTreeMap<String, String>,
}

impl ForgePromotions {
    pub fn parse(json: &str) -> Result<Self, ForgeError> {
        if json.trim().is_empty() {
            return Err(ForgeError::EmptyInput {
                field: "promotions_slim.json".to_owned(),
            });
        }

        let root: Value = serde_json::from_str(json).map_err(|error| ForgeError::InvalidJson {
            detail: format!("promotions_slim.json: {error}"),
        })?;

        let root_object = root
            .as_object()
            .ok_or_else(|| ForgeError::InvalidPromotions {
                detail: "promotions_slim.json root must be a JSON object".to_owned(),
            })?;

        let promos = root_object
            .get("promos")
            .ok_or_else(|| ForgeError::InvalidPromotions {
                detail: "promotions_slim.json is missing the `promos` object".to_owned(),
            })?
            .as_object()
            .ok_or_else(|| ForgeError::InvalidPromotions {
                detail: "promotions_slim.json `promos` must be a JSON object".to_owned(),
            })?;

        if promos.is_empty() {
            return Err(ForgeError::InvalidPromotions {
                detail: "promotions_slim.json `promos` must not be empty".to_owned(),
            });
        }

        let mut entries = BTreeMap::new();
        for (key, value) in promos {
            let (minecraft_version, channel) = parse_promotion_key(key)?;
            validate_minecraft_version(&minecraft_version)?;

            let forge_version = value
                .as_str()
                .ok_or_else(|| ForgeError::InvalidPromotions {
                    detail: format!("promotion {key:?} must contain a string build"),
                })?;
            validate_forge_build(forge_version).map_err(|error| ForgeError::InvalidPromotions {
                detail: format!("promotion {key:?}: {error}"),
            })?;

            let canonical_key = promotion_key(&minecraft_version, channel);
            if entries
                .insert(canonical_key.clone(), forge_version.to_owned())
                .is_some()
            {
                return Err(ForgeError::InvalidPromotions {
                    detail: format!("duplicate promotion {canonical_key:?}"),
                });
            }
        }

        Ok(Self { entries })
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn resolve(&self, minecraft_version: &str) -> Result<ForgeBuild, ForgeError> {
        validate_minecraft_version(minecraft_version)?;

        let recommended_key = promotion_key(minecraft_version, ForgeChannel::Recommended);
        let latest_key = promotion_key(minecraft_version, ForgeChannel::Latest);

        let (build, channel) = self
            .entries
            .get(&recommended_key)
            .map(|build| (build.as_str(), ForgeChannel::Recommended))
            .or_else(|| {
                self.entries
                    .get(&latest_key)
                    .map(|build| (build.as_str(), ForgeChannel::Latest))
            })
            .ok_or_else(|| ForgeError::UnknownMinecraftVersion {
                minecraft_version: minecraft_version.to_owned(),
            })?;

        ForgeBuild::new(minecraft_version, build, channel)
    }

    pub fn resolve_with_channel(
        &self,
        minecraft_version: &str,
        channel: ForgeChannel,
    ) -> Result<ForgeBuild, ForgeError> {
        match channel {
            ForgeChannel::Recommended => self.resolve(minecraft_version),
            ForgeChannel::Latest => {
                validate_minecraft_version(minecraft_version)?;
                let key = promotion_key(minecraft_version, ForgeChannel::Latest);
                let build = self
                    .entries
                    .get(&key)
                    .ok_or_else(|| ForgeError::MissingPromotion {
                        minecraft_version: minecraft_version.to_owned(),
                        channel: ForgeChannel::Latest,
                    })?;
                ForgeBuild::new(minecraft_version, build, ForgeChannel::Latest)
            }
            ForgeChannel::Explicit => Err(ForgeError::InvalidPromotions {
                detail: "the explicit channel requires a caller-supplied Forge build".to_owned(),
            }),
        }
    }
}

pub fn parse_promotions_slim(json: &str) -> Result<ForgePromotions, ForgeError> {
    ForgePromotions::parse(json)
}

pub fn parse_forge_promotions(json: &str) -> Result<ForgePromotions, ForgeError> {
    parse_promotions_slim(json)
}

pub fn resolve_forge_build(
    promotions_json: &str,
    minecraft_version: &str,
) -> Result<ForgeBuild, ForgeError> {
    parse_promotions_slim(promotions_json)?.resolve(minecraft_version)
}

pub fn select_forge_build(
    promotions_json: &str,
    minecraft_version: &str,
) -> Result<ForgeBuild, ForgeError> {
    resolve_forge_build(promotions_json, minecraft_version)
}

pub fn resolve_installable_forge_build(
    promotions_json: &str,
    minecraft_version: &str,
) -> Result<ForgeBuild, ForgeError> {
    let build = resolve_forge_build(promotions_json, minecraft_version)?;
    build.ensure_headless_client_install_supported()?;
    Ok(build)
}

pub fn resolve_forge_build_with_channel(
    promotions_json: &str,
    minecraft_version: &str,
    channel: ForgeChannel,
) -> Result<ForgeBuild, ForgeError> {
    parse_promotions_slim(promotions_json)?.resolve_with_channel(minecraft_version, channel)
}

pub fn explicit_forge_build(
    minecraft_version: &str,
    forge_version: &str,
) -> Result<ForgeBuild, ForgeError> {
    ForgeBuild::explicit(minecraft_version, forge_version)
}

pub fn build_forge_build(
    minecraft_version: &str,
    forge_version: &str,
    channel: ForgeChannel,
) -> Result<ForgeBuild, ForgeError> {
    ForgeBuild::new(minecraft_version, forge_version, channel)
}

pub fn validate_safe_path_component(value: &str, field: &str) -> Result<(), ForgeError> {
    if value.is_empty() {
        return Err(ForgeError::EmptyInput {
            field: field.to_owned(),
        });
    }

    if value.chars().any(|character| character.is_control()) {
        return Err(ForgeError::UnsafePathComponent {
            field: field.to_owned(),
            value: value.to_owned(),
            reason: "control characters (including NUL) are not allowed".to_owned(),
        });
    }

    if value.contains('/') || value.contains('\\') {
        return Err(ForgeError::UnsafePathComponent {
            field: field.to_owned(),
            value: value.to_owned(),
            reason: "path separators are not allowed".to_owned(),
        });
    }

    if value.contains("..") {
        return Err(ForgeError::UnsafePathComponent {
            field: field.to_owned(),
            value: value.to_owned(),
            reason: "`..` is not allowed in a path component".to_owned(),
        });
    }

    if value.contains("://") || value.contains(':') {
        return Err(ForgeError::UnsafePathComponent {
            field: field.to_owned(),
            value: value.to_owned(),
            reason: "URLs and scheme separators are not allowed".to_owned(),
        });
    }

    let allowed = value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'+'));
    if !allowed || value == "." {
        return Err(ForgeError::UnsafePathComponent {
            field: field.to_owned(),
            value: value.to_owned(),
            reason: "only ASCII letters, digits, '.', '_', '-', and '+' are allowed".to_owned(),
        });
    }

    Ok(())
}

pub fn validate_minecraft_version(version: &str) -> Result<(), ForgeError> {
    validate_safe_path_component(version, "Minecraft version")?;

    let mut segment_count = 0usize;
    for segment in version.split('.') {
        if segment.is_empty() || !segment.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(ForgeError::InvalidVersion {
                field: "Minecraft version".to_owned(),
                value: version.to_owned(),
                reason: "every segment must be non-empty and numeric".to_owned(),
            });
        }
        segment_count += 1;
    }

    if segment_count < 2 {
        return Err(ForgeError::InvalidVersion {
            field: "Minecraft version".to_owned(),
            value: version.to_owned(),
            reason: "at least two numeric segments are required".to_owned(),
        });
    }

    Ok(())
}

pub fn validate_forge_build(build: &str) -> Result<(), ForgeError> {
    validate_safe_path_component(build, "Forge build")
}

pub fn technical_profile_id(
    minecraft_version: &str,
    forge_version: &str,
) -> Result<String, ForgeError> {
    validate_minecraft_version(minecraft_version)?;
    validate_forge_build(forge_version)?;
    Ok(format!("{minecraft_version}-forge-{forge_version}"))
}

pub fn forge_profile_id(
    minecraft_version: &str,
    forge_version: &str,
) -> Result<String, ForgeError> {
    technical_profile_id(minecraft_version, forge_version)
}

pub fn full_forge_version(
    minecraft_version: &str,
    forge_version: &str,
) -> Result<String, ForgeError> {
    validate_minecraft_version(minecraft_version)?;
    validate_forge_build(forge_version)?;
    Ok(format!("{minecraft_version}-{forge_version}"))
}

pub fn forge_installer_url(
    minecraft_version: &str,
    forge_version: &str,
) -> Result<String, ForgeError> {
    let full = full_forge_version(minecraft_version, forge_version)?;
    Ok(format!(
        "{FORGE_MAVEN_BASE_URL}/net/minecraftforge/forge/{full}/forge-{full}-installer.jar"
    ))
}

pub fn forge_installer_sha1_url(
    minecraft_version: &str,
    forge_version: &str,
) -> Result<String, ForgeError> {
    let full = full_forge_version(minecraft_version, forge_version)?;
    Ok(format!(
        "{FORGE_MAVEN_BASE_URL}/net/minecraftforge/forge/{full}/forge-{full}-installer.jar.sha1"
    ))
}

pub fn forge_installer_urls(
    minecraft_version: &str,
    forge_version: &str,
) -> Result<(String, String), ForgeError> {
    Ok((
        forge_installer_url(minecraft_version, forge_version)?,
        forge_installer_sha1_url(minecraft_version, forge_version)?,
    ))
}

pub fn forge_installer_filename(
    minecraft_version: &str,
    forge_version: &str,
) -> Result<String, ForgeError> {
    let full = full_forge_version(minecraft_version, forge_version)?;
    Ok(format!("forge-{full}-installer.jar"))
}

pub fn is_official_forge_maven_url(url: &str) -> bool {
    let Some(path) = url.strip_prefix(FORGE_MAVEN_BASE_URL) else {
        return false;
    };

    let Some(relative_path) = path.strip_prefix('/') else {
        return false;
    };
    !relative_path.is_empty()
        && relative_path.starts_with("net/minecraftforge/forge/")
        && !relative_path.contains("..")
        && !url.chars().any(|character| character.is_control())
        && relative_path.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-' | b'+')
        })
}

fn assert_official_forge_maven_url(url: &str) -> Result<(), ForgeError> {
    if !is_official_forge_maven_url(url) {
        return Err(ForgeError::InvalidForgeUrl {
            url: url.to_owned(),
        });
    }
    Ok(())
}

pub fn supports_headless_client_install(minecraft_version: &str) -> bool {
    try_supports_headless_client_install(minecraft_version).unwrap_or(false)
}

pub fn try_supports_headless_client_install(minecraft_version: &str) -> Result<bool, ForgeError> {
    validate_minecraft_version(minecraft_version)?;
    Ok(is_modern_forge_minecraft_version(minecraft_version))
}

pub fn ensure_headless_client_install_supported(minecraft_version: &str) -> Result<(), ForgeError> {
    if !try_supports_headless_client_install(minecraft_version)? {
        return Err(ForgeError::HeadlessUnsupported {
            minecraft_version: minecraft_version.to_owned(),
        });
    }
    Ok(())
}

fn is_modern_forge_minecraft_version(minecraft_version: &str) -> bool {
    let mut segments = minecraft_version
        .split('.')
        .map(strip_numeric_leading_zeroes);
    let first = segments.next().unwrap_or("");
    let second = segments.next().unwrap_or("");

    if compare_numeric_segments(first, "1") != std::cmp::Ordering::Less {
        return compare_numeric_segments(first, "1") == std::cmp::Ordering::Greater
            || compare_numeric_segments(second, "13") != std::cmp::Ordering::Less;
    }

    false
}

fn strip_numeric_leading_zeroes(value: &str) -> &str {
    let trimmed = value.trim_start_matches('0');
    if trimmed.is_empty() {
        "0"
    } else {
        trimmed
    }
}

fn compare_numeric_segments(left: &str, right: &str) -> std::cmp::Ordering {
    let left = strip_numeric_leading_zeroes(left);
    let right = strip_numeric_leading_zeroes(right);
    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}

pub fn parse_installer_sha1(sidecar: &str) -> Result<String, ForgeError> {
    let (hash, _filename) = parse_installer_sha1_with_filename(sidecar)?;
    Ok(hash)
}

pub fn validate_installer_sha1_sidecar(
    sidecar: &str,
    expected_filename: Option<&str>,
) -> Result<String, ForgeError> {
    let (hash, filename) = parse_installer_sha1_with_filename(sidecar)?;
    if let Some(expected) = expected_filename {
        validate_safe_path_component(expected, "installer filename")?;
        if let Some(actual) = filename.as_deref() {
            if actual != expected {
                return Err(ForgeError::InvalidSha1 {
                    detail: format!(
                        "SHA-1 sidecar filename is {:?}, expected {:?}",
                        actual, expected
                    ),
                });
            }
        }
    }
    Ok(hash)
}

pub fn parse_installer_sha1_with_filename(
    sidecar: &str,
) -> Result<(String, Option<String>), ForgeError> {
    let line = sidecar.trim();
    if line.is_empty() {
        return Err(ForgeError::EmptyInput {
            field: "installer SHA-1 sidecar".to_owned(),
        });
    }

    if line.chars().any(|character| character.is_control()) {
        return Err(ForgeError::InvalidSha1 {
            detail: "SHA-1 sidecar must be one line without control characters".to_owned(),
        });
    }

    let mut fields = line.split_whitespace();
    let first = fields.next().ok_or_else(|| ForgeError::InvalidSha1 {
        detail: "SHA-1 sidecar has no hash".to_owned(),
    })?;

    let (hash_token, attached_filename) = if let Some((hash, filename)) = first.split_once('*') {
        if filename.contains('*') || hash.is_empty() || filename.is_empty() {
            return Err(ForgeError::InvalidSha1 {
                detail: "malformed SHA-1 hash/filename pair".to_owned(),
            });
        }
        (hash, Some(filename))
    } else {
        (first, None)
    };

    let filename = if let Some(second) = fields.next() {
        if attached_filename.is_some() || fields.next().is_some() {
            return Err(ForgeError::InvalidSha1 {
                detail: "SHA-1 sidecar may contain only a hash and one filename".to_owned(),
            });
        }
        let second = second.strip_prefix('*').unwrap_or(second);
        if second.is_empty() {
            return Err(ForgeError::InvalidSha1 {
                detail: "SHA-1 sidecar filename is empty".to_owned(),
            });
        }
        Some(second.to_owned())
    } else {
        attached_filename.map(str::to_owned)
    };

    if hash_token.len() != 40 || !hash_token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ForgeError::InvalidSha1 {
            detail: "installer SHA-1 must contain exactly 40 hexadecimal characters".to_owned(),
        });
    }

    if let Some(name) = &filename {
        validate_safe_path_component(name, "installer filename").map_err(|error| {
            ForgeError::InvalidSha1 {
                detail: format!("invalid SHA-1 sidecar filename: {error}"),
            }
        })?;
    }

    Ok((hash_token.to_ascii_lowercase(), filename))
}

pub fn validate_installer_sha256_sidecar(
    sidecar: &str,
    expected_filename: Option<&str>,
) -> Result<String, ForgeError> {
    let line = sidecar.trim();
    if line.is_empty() || line.chars().any(|character| character.is_control()) {
        return Err(ForgeError::InvalidSha1 {
            detail: "SHA-256 sidecar must be one non-empty line".to_owned(),
        });
    }
    let mut fields = line.split_whitespace();
    let first = fields.next().ok_or_else(|| ForgeError::InvalidSha1 {
        detail: "SHA-256 sidecar has no hash".to_owned(),
    })?;
    let (hash, attached_filename) = first
        .split_once('*')
        .map(|(hash, filename)| (hash, Some(filename)))
        .unwrap_or((first, None));
    let separate_filename = fields
        .next()
        .map(|name| name.strip_prefix('*').unwrap_or(name));
    if attached_filename.is_some() && separate_filename.is_some() || fields.next().is_some() {
        return Err(ForgeError::InvalidSha1 {
            detail: "malformed SHA-256 sidecar".to_owned(),
        });
    }
    let attached_filename = attached_filename.or(separate_filename);
    if attached_filename.is_some_and(str::is_empty) {
        return Err(ForgeError::InvalidSha1 {
            detail: "SHA-256 sidecar filename is empty".to_owned(),
        });
    }
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ForgeError::InvalidSha1 {
            detail: "installer SHA-256 must contain exactly 64 hexadecimal characters".to_owned(),
        });
    }
    if let Some(expected) = expected_filename {
        validate_safe_path_component(expected, "installer filename")?;
        if let Some(actual) = attached_filename {
            validate_safe_path_component(actual, "installer filename")?;
            if actual != expected {
                return Err(ForgeError::InvalidSha1 {
                    detail: format!(
                        "SHA-256 sidecar filename is {actual:?}, expected {expected:?}"
                    ),
                });
            }
        }
    }
    Ok(hash.to_ascii_lowercase())
}

#[allow(clippy::chunks_exact_to_as_chunks)]
pub fn sha1_hex(bytes: &[u8]) -> String {
    let mut message = bytes.to_vec();
    let bit_length = (bytes.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_length.to_be_bytes());

    let mut h0: u32 = 0x6745_2301;
    let mut h1: u32 = 0xefcd_ab89;
    let mut h2: u32 = 0x98ba_dcfe;
    let mut h3: u32 = 0x1032_5476;
    let mut h4: u32 = 0xc3d2_e1f0;

    for chunk in message.chunks_exact(64) {
        let mut words = [0u32; 80];
        for (index, word) in words[..16].iter_mut().enumerate() {
            let offset = index * 4;
            *word = u32::from_be_bytes([
                chunk[offset],
                chunk[offset + 1],
                chunk[offset + 2],
                chunk[offset + 3],
            ]);
        }
        for index in 16..80 {
            words[index] =
                (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16])
                    .rotate_left(1);
        }

        let mut a = h0;
        let mut b = h1;
        let mut c = h2;
        let mut d = h3;
        let mut e = h4;

        for (index, word) in words.iter().enumerate() {
            let (function, constant) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5a82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ed9_eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1b_bcdc),
                60..=79 => (b ^ c ^ d, 0xca62_c1d6),
                _ => unreachable!(),
            };
            let temporary = a
                .rotate_left(5)
                .wrapping_add(function)
                .wrapping_add(e)
                .wrapping_add(constant)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temporary;
        }

        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    format!("{h0:08x}{h1:08x}{h2:08x}{h3:08x}{h4:08x}")
}

pub fn verify_installer_sha1(installer_bytes: &[u8], sidecar: &str) -> Result<String, ForgeError> {
    if installer_bytes.is_empty() {
        return Err(ForgeError::InvalidSha1 {
            detail: "installer bytes are empty".to_owned(),
        });
    }
    let expected = parse_installer_sha1(sidecar)?;
    let actual = sha1_hex(installer_bytes);
    if actual != expected {
        return Err(ForgeError::ChecksumMismatch { expected, actual });
    }
    Ok(expected)
}

pub fn verify_installer_sha1_with_filename(
    installer_bytes: &[u8],
    sidecar: &str,
    expected_filename: &str,
) -> Result<String, ForgeError> {
    if installer_bytes.is_empty() {
        return Err(ForgeError::InvalidSha1 {
            detail: "installer bytes are empty".to_owned(),
        });
    }
    let expected = validate_installer_sha1_sidecar(sidecar, Some(expected_filename))?;
    let actual = sha1_hex(installer_bytes);
    if actual != expected {
        return Err(ForgeError::ChecksumMismatch { expected, actual });
    }
    Ok(expected)
}

pub fn verify_forge_installer(
    build: &ForgeBuild,
    installer_bytes: &[u8],
    sidecar: &str,
) -> Result<String, ForgeError> {
    build.validate()?;
    let filename = forge_installer_filename(&build.minecraft_version, &build.forge_version)?;
    verify_installer_sha1_with_filename(installer_bytes, sidecar, &filename)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeProfileMetadata {
    pub profile_id: String,
    pub main_class: String,
    pub inherits_from: String,
    pub jar: Option<String>,
}

pub fn parse_forge_profile_json(
    profile_json: &str,
    build: &ForgeBuild,
) -> Result<ForgeProfileMetadata, ForgeError> {
    build.validate()?;
    build.ensure_headless_client_install_supported()?;

    if profile_json.trim().is_empty() {
        return Err(ForgeError::ProfileValidation {
            detail: "generated Forge profile JSON is empty".to_owned(),
        });
    }

    let value: Value =
        serde_json::from_str(profile_json).map_err(|error| ForgeError::InvalidJson {
            detail: format!("generated Forge profile JSON: {error}"),
        })?;
    let object = value
        .as_object()
        .ok_or_else(|| ForgeError::ProfileValidation {
            detail: "generated Forge profile JSON root must be an object".to_owned(),
        })?;

    let id = optional_json_string(object, "id")?;
    let profile_id_field = optional_json_string(object, "profileId")?;
    if let (Some(id), Some(profile_id_field)) = (&id, &profile_id_field) {
        if id != profile_id_field {
            return Err(ForgeError::ProfileValidation {
                detail: format!(
                    "profile `id` ({id:?}) and `profileId` ({profile_id_field:?}) disagree"
                ),
            });
        }
    }
    let actual_profile_id = id
        .as_deref()
        .or(profile_id_field.as_deref())
        .ok_or_else(|| ForgeError::ProfileValidation {
            detail: "generated Forge profile is missing `id`/`profileId`".to_owned(),
        })?;
    if actual_profile_id != build.profile_id {
        return Err(ForgeError::ProfileValidation {
            detail: format!(
                "generated Forge profile id is {:?}, expected {:?}",
                actual_profile_id, build.profile_id
            ),
        });
    }

    let main_class = required_json_string(object, "mainClass")?;
    validate_java_class_name(&main_class)?;

    let inherits_from = required_json_string(object, "inheritsFrom")?;
    validate_minecraft_version(&inherits_from).map_err(|error| ForgeError::ProfileValidation {
        detail: format!("invalid `inheritsFrom` in generated Forge profile: {error}"),
    })?;
    if inherits_from != build.minecraft_version {
        return Err(ForgeError::ProfileValidation {
            detail: format!(
                "generated Forge profile inherits from {:?}, expected {:?}",
                inherits_from, build.minecraft_version
            ),
        });
    }

    let jar = optional_json_string(object, "jar")?;
    if let Some(jar) = &jar {
        validate_safe_path_component(jar, "profile jar").map_err(|error| {
            ForgeError::ProfileValidation {
                detail: format!("invalid `jar` in generated Forge profile: {error}"),
            }
        })?;
        if jar != &inherits_from {
            return Err(ForgeError::ProfileValidation {
                detail: format!(
                    "profile `jar` is {:?}, but `inheritsFrom` is {:?}",
                    jar, inherits_from
                ),
            });
        }
    }

    Ok(ForgeProfileMetadata {
        profile_id: actual_profile_id.to_owned(),
        main_class,
        inherits_from,
        jar,
    })
}

pub fn validate_forge_profile_json(
    profile_json: &str,
    build: &ForgeBuild,
) -> Result<(), ForgeError> {
    parse_forge_profile_json(profile_json, build).map(|_| ())
}

pub fn validate_forge_parent_json(parent_json: &str, parent_id: &str) -> Result<(), ForgeError> {
    validate_minecraft_version(parent_id)?;
    if parent_json.trim().is_empty() {
        return Err(ForgeError::ProfileValidation {
            detail: format!("parent Minecraft JSON for {parent_id:?} is empty"),
        });
    }

    let value: Value =
        serde_json::from_str(parent_json).map_err(|error| ForgeError::InvalidJson {
            detail: format!("parent Minecraft JSON for {parent_id:?}: {error}"),
        })?;
    let object = value
        .as_object()
        .ok_or_else(|| ForgeError::ProfileValidation {
            detail: format!("parent Minecraft JSON for {parent_id:?} is not an object"),
        })?;
    let id = optional_json_string(object, "id")?;
    let profile_id = optional_json_string(object, "profileId")?;
    if let (Some(id), Some(profile_id)) = (&id, &profile_id) {
        if id != profile_id {
            return Err(ForgeError::ProfileValidation {
                detail: format!(
                    "parent JSON id/profileId disagree for {:?}: {:?} vs {:?}",
                    parent_id, id, profile_id
                ),
            });
        }
    }
    let actual =
        id.as_deref()
            .or(profile_id.as_deref())
            .ok_or_else(|| ForgeError::ProfileValidation {
                detail: format!("parent Minecraft JSON for {parent_id:?} has no id/profileId"),
            })?;
    if actual != parent_id {
        return Err(ForgeError::ProfileValidation {
            detail: format!("parent JSON id is {:?}, expected {:?}", actual, parent_id),
        });
    }

    Ok(())
}

pub fn validate_forge_profile_with_parent(
    profile_json: &str,
    parent_json: &str,
    parent_jar_size: u64,
    build: &ForgeBuild,
) -> Result<ForgeProfileMetadata, ForgeError> {
    if parent_jar_size == 0 {
        return Err(ForgeError::ProfileValidation {
            detail: format!(
                "parent Minecraft JAR for {:?} is empty or missing",
                build.minecraft_version
            ),
        });
    }
    let metadata = parse_forge_profile_json(profile_json, build)?;
    validate_forge_parent_json(parent_json, &build.minecraft_version)?;
    Ok(metadata)
}

pub fn validate_forge_profile<P: AsRef<Path>>(
    versions_dir: P,
    build: &ForgeBuild,
) -> Result<ForgeInstallResult, ForgeError> {
    let versions_dir = versions_dir.as_ref();
    build.validate()?;
    build.ensure_headless_client_install_supported()?;

    ensure_directory(versions_dir, "Minecraft versions directory")?;
    let profile_dir = versions_dir.join(&build.profile_id);
    ensure_directory(&profile_dir, "generated Forge profile directory")?;

    let profile_json_path = profile_dir.join(format!("{}.json", build.profile_id));
    let profile_json = read_required_text(&profile_json_path, "generated Forge profile JSON")?;
    parse_forge_profile_json(&profile_json, build)?;

    let parent_dir = versions_dir.join(&build.minecraft_version);
    ensure_directory(&parent_dir, "parent Minecraft version directory")?;
    let parent_json_path = parent_dir.join(format!("{}.json", build.minecraft_version));
    let parent_jar_path = parent_dir.join(format!("{}.jar", build.minecraft_version));
    let parent_json = read_required_text(&parent_json_path, "parent Minecraft JSON")?;
    validate_forge_parent_json(&parent_json, &build.minecraft_version)?;
    let parent_jar_size = required_file_size(&parent_jar_path, "parent Minecraft JAR")?;
    if parent_jar_size == 0 {
        return Err(ForgeError::ProfileValidation {
            detail: format!(
                "parent Minecraft JAR {} is empty",
                parent_jar_path.display()
            ),
        });
    }

    ForgeInstallResult::from_validated_profile(
        build,
        profile_json_path,
        parent_json_path,
        parent_jar_path,
    )
}

pub fn validate_forge_profile_files(
    profile_json: &str,
    parent_json: &str,
    parent_jar_size: u64,
    build: &ForgeBuild,
) -> Result<ForgeProfileMetadata, ForgeError> {
    validate_forge_profile_with_parent(profile_json, parent_json, parent_jar_size, build)
}

fn parse_promotion_key(key: &str) -> Result<(String, ForgeChannel), ForgeError> {
    if let Some(version) = key.strip_suffix("-recommended") {
        return Ok((version.to_owned(), ForgeChannel::Recommended));
    }
    if let Some(version) = key.strip_suffix("-latest") {
        return Ok((version.to_owned(), ForgeChannel::Latest));
    }
    Err(ForgeError::InvalidPromotions {
        detail: format!("promotion key {key:?} must end in `-recommended` or `-latest`"),
    })
}

fn promotion_key(minecraft_version: &str, channel: ForgeChannel) -> String {
    format!("{minecraft_version}-{}", channel.as_str())
}

fn optional_json_string(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<String>, ForgeError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        Some(Value::String(_)) => Err(ForgeError::ProfileValidation {
            detail: format!("`{key}` must not be empty"),
        }),
        Some(_) => Err(ForgeError::ProfileValidation {
            detail: format!("`{key}` must be a string"),
        }),
    }
}

fn required_json_string(object: &Map<String, Value>, key: &str) -> Result<String, ForgeError> {
    optional_json_string(object, key)?.ok_or_else(|| ForgeError::ProfileValidation {
        detail: format!("generated Forge profile is missing `{key}`"),
    })
}

fn validate_java_class_name(class_name: &str) -> Result<(), ForgeError> {
    if class_name.is_empty()
        || class_name.len() > 512
        || class_name.chars().any(|character| character.is_control())
        || class_name.contains("..")
    {
        return Err(ForgeError::ProfileValidation {
            detail: format!("invalid Forge mainClass {:?}", class_name),
        });
    }

    for segment in class_name.split('.') {
        let mut characters = segment.chars();
        let Some(first) = characters.next() else {
            return Err(ForgeError::ProfileValidation {
                detail: format!("invalid Forge mainClass {:?}", class_name),
            });
        };
        if !(first.is_ascii_alphabetic() || first == '_' || first == '$')
            || !characters.all(|character| {
                character.is_ascii_alphanumeric() || character == '_' || character == '$'
            })
        {
            return Err(ForgeError::ProfileValidation {
                detail: format!("invalid Forge mainClass {:?}", class_name),
            });
        }
    }

    Ok(())
}

fn ensure_directory(path: &Path, label: &str) -> Result<(), ForgeError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| ForgeError::Io {
        path: path.display().to_string(),
        detail: format!("cannot inspect {label}: {error}"),
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ForgeError::ProfileValidation {
            detail: format!("{label} {} is not a real directory", path.display()),
        });
    }
    Ok(())
}

fn read_required_text(path: &Path, label: &str) -> Result<String, ForgeError> {
    let size = required_file_size(path, label)?;
    if size == 0 {
        return Err(ForgeError::ProfileValidation {
            detail: format!("{label} {} is empty", path.display()),
        });
    }
    fs::read_to_string(path).map_err(|error| ForgeError::Io {
        path: path.display().to_string(),
        detail: format!("cannot read {label}: {error}"),
    })
}

fn required_file_size(path: &Path, label: &str) -> Result<u64, ForgeError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| ForgeError::Io {
        path: path.display().to_string(),
        detail: format!("cannot inspect {label}: {error}"),
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ForgeError::ProfileValidation {
            detail: format!("{label} {} is not a regular file", path.display()),
        });
    }
    Ok(metadata.len())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeoForgeBuild {
    pub minecraft_version: String,
    pub neoforge_version: String,
    pub profile_id: String,
    pub installer_url: String,
    pub installer_sha1_url: String,
    pub installer_sha256_url: String,
}

impl NeoForgeBuild {
    pub fn new(
        minecraft_version: impl AsRef<str>,
        neoforge_version: impl AsRef<str>,
    ) -> Result<Self, ForgeError> {
        let minecraft_version = minecraft_version.as_ref();
        let neoforge_version = neoforge_version.as_ref();
        validate_minecraft_version(minecraft_version)?;
        validate_neoforge_version(neoforge_version)?;
        validate_neoforge_mapping(minecraft_version, neoforge_version)?;

        let profile_id = format!("neoforge-{neoforge_version}");
        let (installer_url, installer_sha1_url) = neoforge_installer_urls(neoforge_version)?;
        let installer_sha256_url = neoforge_installer_sha256_url(neoforge_version)?;

        Ok(Self {
            minecraft_version: minecraft_version.to_owned(),
            neoforge_version: neoforge_version.to_owned(),
            profile_id,
            installer_url,
            installer_sha1_url,
            installer_sha256_url,
        })
    }

    pub fn validate(&self) -> Result<(), ForgeError> {
        validate_minecraft_version(&self.minecraft_version)?;
        validate_neoforge_version(&self.neoforge_version)?;
        validate_neoforge_mapping(&self.minecraft_version, &self.neoforge_version)?;
        let expected_profile = format!("neoforge-{}", self.neoforge_version);
        if self.profile_id != expected_profile {
            return Err(ForgeError::ProfileValidation {
                detail: format!(
                    "profileId must be {:?}, got {:?}",
                    expected_profile, self.profile_id
                ),
            });
        }
        let (expected_installer, expected_sha1) = neoforge_installer_urls(&self.neoforge_version)?;
        let expected_sha256 = neoforge_installer_sha256_url(&self.neoforge_version)?;
        if !is_official_neoforge_url(&self.installer_url)
            || !is_official_neoforge_url(&self.installer_sha1_url)
            || !is_official_neoforge_url(&self.installer_sha256_url)
        {
            return Err(ForgeError::InvalidNeoForgeUrl {
                url: self.installer_url.clone(),
            });
        }
        if self.installer_url != expected_installer
            || self.installer_sha1_url != expected_sha1
            || self.installer_sha256_url != expected_sha256
        {
            return Err(ForgeError::InvalidNeoForgeUrl {
                url: self.installer_url.clone(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeoForgeInstallResult {
    pub minecraft_version: String,
    pub neoforge_version: String,
    pub profile_id: String,
    pub installer_url: String,
    pub installer_sha1_url: String,
    pub installer_sha256_url: String,
    pub supports_headless_client_install: bool,
    pub profile_json_path: PathBuf,
    pub parent_json_path: PathBuf,
    pub parent_jar_path: PathBuf,
}

pub fn validate_neoforge_version(version: &str) -> Result<(), ForgeError> {
    validate_safe_path_component(version, "NeoForge version")?;
    let segments: Vec<&str> = version.split('.').collect();
    if !(3..=4).contains(&segments.len())
        || segments
            .iter()
            .any(|segment| segment.is_empty() || !segment.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(ForgeError::InvalidVersion {
            field: "NeoForge version".to_owned(),
            value: version.to_owned(),
            reason: "expected three or four numeric segments".to_owned(),
        });
    }
    Ok(())
}

pub fn neoforge_minecraft_version(neoforge_version: &str) -> Result<String, ForgeError> {
    validate_neoforge_version(neoforge_version)?;
    let parts: Vec<u32> = neoforge_version
        .split('.')
        .map(|part| {
            part.parse::<u32>().map_err(|_| ForgeError::InvalidVersion {
                field: "NeoForge version".to_owned(),
                value: neoforge_version.to_owned(),
                reason: "segments must fit into an unsigned integer".to_owned(),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    if parts[0] >= 26 {
        if parts.len() != 4 {
            return Err(ForgeError::InvalidVersion {
                field: "NeoForge version".to_owned(),
                value: neoforge_version.to_owned(),
                reason: "26.x NeoForge versions must contain four numeric segments".to_owned(),
            });
        }
        let patch = parts[2];
        return Ok(if patch == 0 {
            format!("{}.{}", parts[0], parts[1])
        } else {
            format!("{}.{}.{}", parts[0], parts[1], patch)
        });
    }

    if parts.len() != 3 || parts[0] < 20 {
        return Err(ForgeError::InvalidVersion {
            field: "NeoForge version".to_owned(),
            value: neoforge_version.to_owned(),
            reason: "legacy NeoForge versions must use the 20.x/21.x three-segment scheme"
                .to_owned(),
        });
    }
    Ok(if parts[1] == 0 {
        format!("1.{}", parts[0])
    } else {
        format!("1.{}.{}", parts[0], parts[1])
    })
}

fn validate_neoforge_mapping(
    minecraft_version: &str,
    neoforge_version: &str,
) -> Result<(), ForgeError> {
    let expected = neoforge_minecraft_version(neoforge_version)?;
    if expected != minecraft_version {
        return Err(ForgeError::ProfileValidation {
            detail: format!(
                "NeoForge {} targets Minecraft {}, not {}",
                neoforge_version, expected, minecraft_version
            ),
        });
    }
    Ok(())
}

pub fn neoforge_installer_urls(neoforge_version: &str) -> Result<(String, String), ForgeError> {
    validate_neoforge_version(neoforge_version)?;
    let base = format!("{NEOFORGE_MAVEN_BASE_URL}/net/neoforged/neoforge/{neoforge_version}");
    Ok((
        format!("{base}/neoforge-{neoforge_version}-installer.jar"),
        format!("{base}/neoforge-{neoforge_version}-installer.jar.sha1"),
    ))
}

pub fn neoforge_installer_sha256_url(neoforge_version: &str) -> Result<String, ForgeError> {
    let (installer_url, _) = neoforge_installer_urls(neoforge_version)?;
    Ok(format!("{installer_url}.sha256"))
}

pub fn neoforge_installer_filename(neoforge_version: &str) -> Result<String, ForgeError> {
    validate_neoforge_version(neoforge_version)?;
    Ok(format!("neoforge-{neoforge_version}-installer.jar"))
}

pub fn is_official_neoforge_url(url: &str) -> bool {
    let Some(path) = url.strip_prefix(NEOFORGE_MAVEN_BASE_URL) else {
        return false;
    };
    let Some(relative_path) = path.strip_prefix('/') else {
        return false;
    };
    !relative_path.is_empty()
        && relative_path.starts_with("net/neoforged/neoforge/")
        && !relative_path.contains("..")
        && !url.chars().any(|character| character.is_control())
        && relative_path.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-' | b'+')
        })
}

pub fn validate_neoforge_profile_json(
    profile_json: &str,
    build: &NeoForgeBuild,
) -> Result<(), ForgeError> {
    build.validate()?;
    if profile_json.trim().is_empty() {
        return Err(ForgeError::ProfileValidation {
            detail: "generated NeoForge profile JSON is empty".to_owned(),
        });
    }
    let value: Value =
        serde_json::from_str(profile_json).map_err(|error| ForgeError::InvalidJson {
            detail: format!("generated NeoForge profile JSON: {error}"),
        })?;
    let object = value
        .as_object()
        .ok_or_else(|| ForgeError::ProfileValidation {
            detail: "generated NeoForge profile JSON root must be an object".to_owned(),
        })?;
    let id = optional_json_string(object, "id")?;
    let profile_id_field = optional_json_string(object, "profileId")?;
    if let (Some(id), Some(profile_id_field)) = (&id, &profile_id_field) {
        if id != profile_id_field {
            return Err(ForgeError::ProfileValidation {
                detail: format!(
                    "profile `id` ({id:?}) and `profileId` ({profile_id_field:?}) disagree"
                ),
            });
        }
    }
    let actual_id = id
        .as_deref()
        .or(profile_id_field.as_deref())
        .ok_or_else(|| ForgeError::ProfileValidation {
            detail: "generated NeoForge profile is missing `id`/`profileId`".to_owned(),
        })?;
    if actual_id != build.profile_id {
        return Err(ForgeError::ProfileValidation {
            detail: format!(
                "generated NeoForge profile id is {:?}, expected {:?}",
                actual_id, build.profile_id
            ),
        });
    }

    let main_class = required_json_string(object, "mainClass")?;
    validate_java_class_name(&main_class)?;
    let inherits_from = required_json_string(object, "inheritsFrom")?;
    validate_minecraft_version(&inherits_from).map_err(|error| ForgeError::ProfileValidation {
        detail: format!("invalid `inheritsFrom` in generated NeoForge profile: {error}"),
    })?;
    if inherits_from != build.minecraft_version {
        return Err(ForgeError::ProfileValidation {
            detail: format!(
                "generated NeoForge profile inherits from {:?}, expected {:?}",
                inherits_from, build.minecraft_version
            ),
        });
    }
    if let Some(jar) = optional_json_string(object, "jar")? {
        validate_safe_path_component(&jar, "profile jar").map_err(|error| {
            ForgeError::ProfileValidation {
                detail: format!("invalid `jar` in generated NeoForge profile: {error}"),
            }
        })?;
        if jar != inherits_from {
            return Err(ForgeError::ProfileValidation {
                detail: format!(
                    "profile `jar` is {:?}, but `inheritsFrom` is {:?}",
                    jar, inherits_from
                ),
            });
        }
    }
    Ok(())
}

pub fn validate_neoforge_profile<P: AsRef<Path>>(
    versions_dir: P,
    build: &NeoForgeBuild,
) -> Result<NeoForgeInstallResult, ForgeError> {
    let versions_dir = versions_dir.as_ref();
    build.validate()?;

    ensure_directory(versions_dir, "Minecraft versions directory")?;
    let profile_dir = versions_dir.join(&build.profile_id);
    ensure_directory(&profile_dir, "generated NeoForge profile directory")?;
    let profile_json_path = profile_dir.join(format!("{}.json", build.profile_id));
    let profile_json = read_required_text(&profile_json_path, "generated NeoForge profile JSON")?;
    validate_neoforge_profile_json(&profile_json, build)?;

    let parent_dir = versions_dir.join(&build.minecraft_version);
    ensure_directory(&parent_dir, "parent Minecraft version directory")?;
    let parent_json_path = parent_dir.join(format!("{}.json", build.minecraft_version));
    let parent_jar_path = parent_dir.join(format!("{}.jar", build.minecraft_version));
    let parent_json = read_required_text(&parent_json_path, "parent Minecraft JSON")?;
    validate_forge_parent_json(&parent_json, &build.minecraft_version)?;
    if required_file_size(&parent_jar_path, "parent Minecraft JAR")? == 0 {
        return Err(ForgeError::ProfileValidation {
            detail: format!(
                "parent Minecraft JAR {} is empty",
                parent_jar_path.display()
            ),
        });
    }

    Ok(NeoForgeInstallResult {
        minecraft_version: build.minecraft_version.clone(),
        neoforge_version: build.neoforge_version.clone(),
        profile_id: build.profile_id.clone(),
        installer_url: build.installer_url.clone(),
        installer_sha1_url: build.installer_sha1_url.clone(),
        installer_sha256_url: build.installer_sha256_url.clone(),
        supports_headless_client_install: true,
        profile_json_path,
        parent_json_path,
        parent_jar_path,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ForgeError {
    EmptyInput {
        field: String,
    },
    InvalidJson {
        detail: String,
    },
    InvalidPromotions {
        detail: String,
    },
    UnknownMinecraftVersion {
        minecraft_version: String,
    },
    MissingPromotion {
        minecraft_version: String,
        channel: ForgeChannel,
    },
    InvalidVersion {
        field: String,
        value: String,
        reason: String,
    },
    UnsafePathComponent {
        field: String,
        value: String,
        reason: String,
    },
    HeadlessUnsupported {
        minecraft_version: String,
    },
    InvalidSha1 {
        detail: String,
    },
    ChecksumMismatch {
        expected: String,
        actual: String,
    },
    InvalidForgeUrl {
        url: String,
    },
    InvalidNeoForgeUrl {
        url: String,
    },
    ProfileValidation {
        detail: String,
    },
    Io {
        path: String,
        detail: String,
    },
}

impl fmt::Display for ForgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyInput { field } => write!(formatter, "{field} must not be empty"),
            Self::InvalidJson { detail } => write!(formatter, "invalid JSON: {detail}"),
            Self::InvalidPromotions { detail } => {
                write!(formatter, "invalid Forge promotions document: {detail}")
            }
            Self::UnknownMinecraftVersion { minecraft_version } => write!(
                formatter,
                "Minecraft version {minecraft_version:?} is not present in Forge promotions"
            ),
            Self::MissingPromotion {
                minecraft_version,
                channel,
            } => write!(
                formatter,
                "Forge promotions contain no {channel} build for Minecraft {minecraft_version:?}"
            ),
            Self::InvalidVersion {
                field,
                value,
                reason,
            } => write!(formatter, "invalid {field} {value:?}: {reason}"),
            Self::UnsafePathComponent {
                field,
                value,
                reason,
            } => write!(formatter, "unsafe {field} {value:?}: {reason}"),
            Self::HeadlessUnsupported { minecraft_version } => write!(
                formatter,
                "Forge for Minecraft {minecraft_version} (1.12.2 and older) does not support \
                 the headless client installation flow; use the official Forge installer \
                 interactively instead"
            ),
            Self::InvalidSha1 { detail } => write!(formatter, "invalid installer SHA-1: {detail}"),
            Self::ChecksumMismatch { expected, actual } => write!(
                formatter,
                "installer SHA-1 mismatch: expected {expected}, got {actual}"
            ),
            Self::InvalidForgeUrl { url } => write!(
                formatter,
                "Forge installer URL is not an exact official Maven URL: {url:?}"
            ),
            Self::InvalidNeoForgeUrl { url } => write!(
                formatter,
                "NeoForge installer URL is not an exact official Maven URL: {url:?}"
            ),
            Self::ProfileValidation { detail } => {
                write!(formatter, "Forge profile validation failed: {detail}")
            }
            Self::Io { path, detail } => {
                write!(formatter, "filesystem error at {path:?}: {detail}")
            }
        }
    }
}

impl std::error::Error for ForgeError {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn promotions(recommended: Option<(&str, &str)>, latest: Option<(&str, &str)>) -> String {
        let mut entries = Vec::new();
        if let Some((version, build)) = recommended {
            entries.push(format!("\"{version}-recommended\":\"{build}\""));
        }
        if let Some((version, build)) = latest {
            entries.push(format!("\"{version}-latest\":\"{build}\""));
        }
        format!("{{\"promos\":{{{}}}}}", entries.join(","))
    }

    #[test]
    fn recommended_is_selected_before_latest() {
        let json = promotions(Some(("1.20.1", "47.2.0")), Some(("1.20.1", "47.3.0")));
        let build = resolve_forge_build(&json, "1.20.1").unwrap();

        assert_eq!(build.channel, ForgeChannel::Recommended);
        assert_eq!(build.forge_version, "47.2.0");
        assert_eq!(build.full_forge_version, "1.20.1-47.2.0");
        assert_eq!(build.profile_id, "1.20.1-forge-47.2.0");
    }

    #[test]
    fn latest_is_used_when_recommended_is_missing() {
        let json = promotions(None, Some(("26.1", "1.0.1")));
        let build = resolve_forge_build(&json, "26.1").unwrap();

        assert_eq!(build.channel, ForgeChannel::Latest);
        assert_eq!(build.profile_id, "26.1-forge-1.0.1");
        assert!(build.supports_headless_client_install());
    }

    #[test]
    fn malformed_empty_and_wrong_promotions_are_rejected() {
        assert!(parse_promotions_slim("").is_err());
        assert!(parse_promotions_slim("not json").is_err());
        assert!(parse_promotions_slim("{}").is_err());
        assert!(parse_promotions_slim("{\"promos\":{}}").is_err());
        assert!(parse_promotions_slim("{\"promos\":[]}").is_err());
        assert!(parse_promotions_slim("{\"promos\":{\"1.20.1-latest\":7}}").is_err());
        assert!(parse_promotions_slim("{\"promos\":{\"1.20.1\": \"47.2.0\"}}").is_err());
    }

    #[test]
    fn unknown_minecraft_is_rejected() {
        let json = promotions(Some(("1.20.1", "47.2.0")), None);
        let error = resolve_forge_build(&json, "1.21.1").unwrap_err();
        assert!(error.to_string().contains("not present"));
    }

    #[test]
    fn modern_26_x_and_legacy_ranges_are_explicit() {
        assert!(supports_headless_client_install("1.13"));
        assert!(supports_headless_client_install("1.20.1"));
        assert!(supports_headless_client_install("1.20.1.0.1"));
        assert!(supports_headless_client_install("26.1"));
        assert!(!supports_headless_client_install("1.12.2"));
        assert!(!supports_headless_client_install("1.7.10"));
        assert!(try_supports_headless_client_install("1.12.2").is_ok());
        let error = ensure_headless_client_install_supported("1.12.2").unwrap_err();
        assert!(error.to_string().contains("headless"));
    }

    #[test]
    fn versions_and_builds_are_safe_single_path_components() {
        assert!(validate_minecraft_version("1.20.1").is_ok());
        assert!(validate_minecraft_version("1.20.1.4.9").is_ok());
        assert!(validate_minecraft_version("26.1").is_ok());
        assert!(validate_forge_build("47.2.0").is_ok());
        assert!(validate_forge_build("47.2.0-build.1").is_ok());

        for value in [
            "1.20.1/evil",
            "1.20.1\\evil",
            "1.20.1..evil",
            "https://example.invalid/1.20.1",
            "1.20.1\0evil",
            "1.20.1\u{0001}evil",
            "1.x.1",
        ] {
            assert!(
                validate_minecraft_version(value).is_err(),
                "accepted {value:?}"
            );
        }
        for value in [
            "47.2.0/evil",
            "47..2.0",
            "https://evil.invalid",
            "47\u{0000}",
        ] {
            assert!(validate_forge_build(value).is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn build_serialization_uses_camel_case_and_channel_values() {
        let build = explicit_forge_build("1.20.1", "47.2.0").unwrap();
        let value = serde_json::to_value(&build).unwrap();
        assert!(value.get("minecraftVersion").is_some());
        assert!(value.get("forgeVersion").is_some());
        assert!(value.get("fullForgeVersion").is_some());
        assert!(value.get("profileId").is_some());
        assert!(value.get("installerUrl").is_some());
        assert!(value.get("installerSha1Url").is_some());
        assert_eq!(value["channel"], "explicit");
        assert!(value.get("minecraft_version").is_none());
        assert!(value.get("installer_url").is_none());
    }

    #[test]
    fn urls_are_generated_only_from_the_official_maven() {
        let (installer, sha1) = forge_installer_urls("1.20.1", "47.2.0").unwrap();
        assert_eq!(
            installer,
            "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar"
        );
        assert_eq!(
            sha1,
            "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar.sha1"
        );
        assert!(is_official_forge_maven_url(&installer));
        assert!(!is_official_forge_maven_url(
            "https://maven.minecraftforge.net.evil.invalid/forge.jar"
        ));
        assert!(forge_installer_url("1.20.1", "https://evil.invalid").is_err());

        let mut build = explicit_forge_build("1.20.1", "47.2.0").unwrap();
        build.installer_url = "https://evil.invalid/forge.jar".to_owned();
        assert!(build.validate().is_err());
    }

    #[test]
    fn neoforge_urls_and_profile_ids_are_server_constructed() {
        let build = NeoForgeBuild::new("1.21.1", "21.1.209").unwrap();
        assert_eq!(build.profile_id, "neoforge-21.1.209");
        assert_eq!(
            build.installer_url,
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.209/neoforge-21.1.209-installer.jar"
        );
        assert!(is_official_neoforge_url(&build.installer_url));
        assert!(build.installer_sha256_url.ends_with(".sha256"));
        let sha256 = "a".repeat(64);
        assert_eq!(
            validate_installer_sha256_sidecar(&sha256, None).unwrap(),
            sha256
        );
        assert_eq!(
            validate_installer_sha256_sidecar(
                &format!("{sha256} *neoforge-21.1.209-installer.jar"),
                Some("neoforge-21.1.209-installer.jar")
            )
            .unwrap(),
            sha256
        );
        assert!(!is_official_neoforge_url(
            "https://maven.neoforged.net.evil.invalid/releases/neoforge.jar"
        ));
        assert!(NeoForgeBuild::new("1.21.1", "21.1.209/evil").is_err());
        assert!(NeoForgeBuild::new("1.21.1", "21.1.209-beta").is_err());

        let modern = NeoForgeBuild::new("26.1.2", "26.1.2.75").unwrap();
        assert_eq!(modern.profile_id, "neoforge-26.1.2.75");
        assert!(modern.validate().is_ok());
        assert_eq!(neoforge_minecraft_version("21.11.45").unwrap(), "1.21.11");
        assert!(NeoForgeBuild::new("1.21.11", "21.1.209").is_err());
    }

    #[test]
    fn neoforge_generated_profile_requires_exact_identity_and_parent() {
        let build = NeoForgeBuild::new("1.21.1", "21.1.209").unwrap();
        let valid = serde_json::json!({
            "id": "neoforge-21.1.209",
            "inheritsFrom": "1.21.1",
            "jar": null,
            "mainClass": "cpw.mods.bootstraplauncher.BootstrapLauncher"
        })
        .to_string();
        assert!(validate_neoforge_profile_json(&valid, &build).is_ok());

        let wrong_id = valid.replace("neoforge-21.1.209", "neoforge-21.1.210");
        assert!(validate_neoforge_profile_json(&wrong_id, &build).is_err());
        let wrong_parent = valid.replace("1.21.1", "1.21.11");
        assert!(validate_neoforge_profile_json(&wrong_parent, &build).is_err());
    }

    #[test]
    fn sha1_sidecar_accepts_optional_filename_and_rejects_bad_hashes() {
        let hash = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(parse_installer_sha1(hash).unwrap(), hash);
        assert_eq!(
            parse_installer_sha1(&format!("{hash}  forge-installer.jar\n")).unwrap(),
            hash
        );
        assert_eq!(
            validate_installer_sha1_sidecar(hash, Some("forge-installer.jar")).unwrap(),
            hash
        );
        assert_eq!(
            validate_installer_sha1_sidecar(
                &format!("{hash} *forge-installer.jar"),
                Some("forge-installer.jar")
            )
            .unwrap(),
            hash
        );

        for value in [
            "",
            "0123",
            "g123456789abcdef0123456789abcdef01234567",
            "0123456789abcdef0123456789abcdef01234567 extra words here",
            "0123456789abcdef0123456789abcdef01234567 ../evil.jar",
        ] {
            assert!(parse_installer_sha1(value).is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn checksum_verification_uses_sha1_and_reports_mismatch() {
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        let bytes = b"forge installer test bytes";
        let expected = sha1_hex(bytes);
        assert_eq!(expected.len(), 40);
        assert_eq!(verify_installer_sha1(bytes, &expected).unwrap(), expected);
        assert!(verify_installer_sha1(b"different", &expected).is_err());

        let build = explicit_forge_build("1.20.1", "47.2.0").unwrap();
        let sidecar = format!(
            "{expected} *{}",
            forge_installer_filename("1.20.1", "47.2.0").unwrap()
        );
        assert_eq!(
            verify_forge_installer(&build, bytes, &sidecar).unwrap(),
            expected
        );
    }

    #[test]
    fn generated_profile_validation_checks_id_mainclass_inheritance_and_parent() {
        let build = explicit_forge_build("1.20.1", "47.2.0").unwrap();
        let profile = format!(
            "{{\"id\":\"{}\",\"mainClass\":\"net.minecraftforge.client.launcher.Launcher\",\"inheritsFrom\":\"1.20.1\"}}",
            build.profile_id
        );
        let parent =
            "{\"id\":\"1.20.1\",\"downloads\":{\"client\":{\"url\":\"https://example.invalid\"}}}";
        let metadata = validate_forge_profile_with_parent(&profile, parent, 123, &build).unwrap();
        assert_eq!(metadata.inherits_from, "1.20.1");
        assert_eq!(metadata.profile_id, build.profile_id);

        let wrong_id = profile.replace(&build.profile_id, "1.20.1-forge-wrong");
        assert!(validate_forge_profile_json(&wrong_id, &build).is_err());
        assert!(validate_forge_profile_json(
            &profile.replace("net.minecraftforge.client.launcher.Launcher", ""),
            &build
        )
        .is_err());
        assert!(validate_forge_profile_with_parent(&profile, parent, 0, &build).is_err());
    }

    #[test]
    fn generated_profile_filesystem_validation_returns_install_result() {
        let build = explicit_forge_build("1.20.1", "47.2.0").unwrap();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "canger-forge-test-{}-{}",
            std::process::id(),
            counter
        ));
        let versions = root.join("versions");
        let profile_dir = versions.join(&build.profile_id);
        let parent_dir = versions.join("1.20.1");
        fs::create_dir_all(&profile_dir).unwrap();
        fs::create_dir_all(&parent_dir).unwrap();
        fs::write(
            profile_dir.join(format!("{}.json", build.profile_id)),
            format!(
                "{{\"id\":\"{}\",\"mainClass\":\"net.minecraftforge.client.launcher.Launcher\",\"inheritsFrom\":\"1.20.1\"}}",
                build.profile_id
            ),
        )
        .unwrap();
        fs::write(parent_dir.join("1.20.1.json"), "{\"id\":\"1.20.1\"}").unwrap();
        fs::write(parent_dir.join("1.20.1.jar"), b"not-empty-jar").unwrap();

        let result = validate_forge_profile(&versions, &build).unwrap();
        assert_eq!(result.profile_id, build.profile_id);
        assert!(result.supports_headless_client_install);
        assert!(result.parent_jar_path.ends_with("1.20.1.jar"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_profile_is_never_reported_as_headless_installed() {
        let build = explicit_forge_build("1.12.2", "14.23.5.2859").unwrap();
        assert!(!build.supports_headless_client_install());
        let error = build
            .ensure_headless_client_install_supported()
            .unwrap_err();
        assert!(error.to_string().contains("1.12.2"));
        assert!(matches!(error, ForgeError::HeadlessUnsupported { .. }));

        let legacy_promotions = promotions(
            Some(("1.12.2", "14.23.5.2859")),
            Some(("1.12.2", "14.23.5.2860")),
        );
        let error = resolve_installable_forge_build(&legacy_promotions, "1.12.2").unwrap_err();
        assert!(matches!(error, ForgeError::HeadlessUnsupported { .. }));
    }
}
