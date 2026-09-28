# Changelog

All notable changes to canger are documented in this file.

## [Unreleased]

### Fixed

- Import and move into a subfolder failed with `Invalid import destination` on
  Windows. The guard derived the relative path by stripping the game directory off
  a canonicalized target, but `canonicalize` returns a `\\?\` verbatim path on
  Windows, so the strip never matched. Guards are now built from the caller's
  subpath string; the write still goes to the validated path.

### Added

- Linux: Java discovery for `/usr/lib/jvm`, `/usr/lib64/jvm`, `/usr/java`,
  `/opt/java`, `/Library/Java/JavaVirtualMachines`, `~/.jdks` and
  `~/.sdkman/candidates/java`. Java executables may be symlinks on Unix, which is
  how distributions usually expose them, as long as the link resolves to a regular
  file. Strict no-symlink handling is unchanged for downloads, extraction and
  atomic replacement.
- Linux bundle targets `deb` and `appimage` in `src-tauri/tauri.linux.conf.json`,
  plus `32x32.png`, `128x128.png`, `128x128@2x.png` and a 512×512 `icon.png`.
- `run-tauri.sh` and `canger-linux-setup.sh` for Arch.

### Added

- Per-version game directories with isolated `mods`, `saves`, `config`, `resourcepacks`, `shaderpacks`, `screenshots`, `logs` and `options.txt`.
- Version-scoped Forge, Fabric and NeoForge catalogs with installed technical versions preserved in the selector.
- Java compatibility preflight for Fabric mods before a game process is started.
- Official NeoForge Maven metadata discovery.
- Legacy native classifier handling for Minecraft 1.8–1.18.2.
- Mojang `os.version` rule matching (`^10\.`-style patterns) instead of blanket rejection.
- CurseForge API key can be supplied through `CANGER_CURSEFORGE_API_KEY` or
  `%APPDATA%\.minecraft\canger\settings.json`; there is deliberately no key entry
  form in the application UI.
- `write_game_file` command used to apply `.mrpack` `overrides/` entries.
- Deterministic newest-first ordering of installed versions.
- GitHub release metadata: `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `rust-toolchain.toml`, `.nvmrc`.

### Changed

- The selected Minecraft version is the source of truth for the game directory.
- Launcher profiles are no longer part of the Tauri UI or IPC.
- Shared `libraries`, `assets`, `objects` and Java runtime remain common.
- Forge cards prefer the `recommended` promotion before falling back to the newest build.
- Modpack installs report partial failures instead of claiming success.
- `launch_game` takes the shared content lock while libraries and natives are written.
- Windows-only bundle targets (`nsis`, `msi`); README states the supported platform explicitly.

### Fixed

- Forge client artifacts with an empty installer URL remain on the classpath.
- Per-version mod folders no longer mix incompatible Fabric mods across versions.
- Version metadata and NeoForge catalog URLs use current official endpoints.
- Launcher-internal files (`<id>.json`, `<id>.jar`, `vanilla.json`, `natives`) can no longer be deleted, moved or overwritten from the file manager.
- Importing files no longer silently overwrites existing files.
- Failed vanilla metadata downloads are reported instead of being swallowed.
- The ASM 9.7.1 → 9.10.1 workaround is applied on every platform, not only Windows.
- Source comments were removed from all first-party files (`561` comments across 19 files).

### Migration

Legacy files under the shared `.minecraft` directory are not moved automatically. Copy or reinstall mods into `versions/<technical-version-id>/mods` for the version you want to use.

## [0.2.0] — planned

- Cross-platform support: macOS and Linux bundles, `icon.icns`, Unix Java discovery,
  `run-tauri.sh`, CI matrix for `windows`/`ubuntu`/`macos`.
