# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The launcher itself is a Windows x64 desktop application (Tauri 2 + Rust + React,
700x400 frameless window). The surface built in this project is its public landing
site, which is a `web` page. No iOS or Android surface exists, and the desktop app
does not adapt its design language per OS, so `adaptive` does not apply.

## Stack

Single self-contained `index.html` with inline CSS and JS, per the user's explicit
choice. Images live as separate files in the same folder because inlining
screenshots as base64 would bloat the file. No build step, no dependencies.

## Users

Primary user: a Russian-speaking Minecraft player who plays modded versions
(Fabric, Forge, NeoForge) and is tired of juggling launcher profiles. The
application UI, README and release notes are all in Russian, and the user writes
in Russian, so the site is Russian-only (confirmed by the user).

Secondary: someone landing on the site from the GitHub release page, who needs to
download a Windows installer within a minute and understand what makes this
launcher different from the official one.

## Product Purpose

canger installs and launches Vanilla, Fabric, Forge and NeoForge versions of
Minecraft from official manifests. The core job: pick a version, get a Java runtime
automatically, and start the game with the right mods for that version and nothing
else. Success means the user never has to think about profiles, never mixes
incompatible mods across versions, and never has to install Java by hand.

## Positioning

Every modded version gets its own real game directory: `versions/<id>` is passed as
`--gameDir` and owns its own `mods`, `saves`, `config`, `resourcepacks`,
`shaderpacks`, `screenshots`, `logs` and `options.txt`. A neighbouring launcher
could copy the feature list; it could not truthfully claim a Rust core that
verifies every installer by SHA-1/SHA-256 and refuses to launch when a Fabric mod's
declared Minecraft or Java range does not match the selected version.

## Operating Context

- Release 0.1.0 is published as GitHub Release `v0.1.0` with an NSIS installer, an
  MSI and a portable `canger.exe`, plus SHA-256 checksums.
- Windows x64 only. Linux and macOS have never been built or tested, and are not
  claimed.
- Installers are not Authenticode-signed, so SmartScreen may warn.
- Existing users who migrated from a shared `.minecraft\mods` folder must move mods
  into `versions/<id>/mods` by hand; nothing is migrated automatically, on purpose.

## Capabilities and Constraints

- Vanilla, snapshots, Fabric, Forge and NeoForge catalogs from official sources.
- Per-version isolated game data, described above.
- Java fetched automatically from Adoptium for the required major version.
- Fabric mod compatibility is verified against `fabric.mod.json` before Java starts.
- CurseForge requires a user-supplied API key; Modrinth needs none.
- One loader card per Minecraft+loader pair, preferring the Forge `recommended`
  promotion.
- Undecided: whether an English version of the site is ever needed; whether a custom
  domain is registered.

## Brand Commitments

Name is `canger`, lowercase, no space. Voice is plain, technical, and in Russian;
the app avoids marketing language. Existing visual cues in the app that the site
must not contradict: dark base `#1e151a`, accent pairs that run from rose
`#a83e6e` through violet `#4a2b9e` and `#5a1fb0` to blue `#1e5ba8`, 16px rounded
window corners, pill-shaped navigation, a pixel-art toggle. No official logo existed
before this project; the site establishes one and the desktop icon follows it.

## Evidence on Hand

- Real release artifacts with checksums: `canger_0.1.0_x64-setup.exe` (3.1 MB),
  `canger_0.1.0_x64_en-US.msi` (4.4 MB), `canger.exe` (12.7 MB).
- Test suite that gates the release: 36 Rust tests, 25 Node smoke tests, clippy with
  `-D warnings`. There is no CI workflow; the suite is run locally before publishing.
- Screenshots of the real application window, captured from the running release
  build.
- Generated brand assets: app icon, favicon, social preview.
- Absences that future work must not fabricate: no user counts, no testimonials,
  no download statistics, no performance benchmarks, no press, no customer logos.

## Product Principles

1. Show the artifact, not adjectives. A real screenshot of the launcher and real
   checksums outrank every claim about it.
2. Version isolation is the whole story. Every piece of copy should ultimately point
   at the fact that each version owns its own game directory.
3. One click to the installer. The download action must be reachable from the first
   viewport without hunting.
4. Never overstate. Windows-only, unsigned, and no invented proof.
5. The site is a front door, not a second product. It links to the release, the
   repository and the changelog, and stops there.

## Accessibility & Inclusion

Not established by the user. Default web baseline applies: semantic landmarks,
keyboard-operable controls, visible focus, text contrast at or above WCAG AA, and
reduced-motion support for any animation.
