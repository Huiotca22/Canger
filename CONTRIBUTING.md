# Contributing

## Requirements

- Node.js `^20.19` or `>=22.12`
- Rust stable toolchain
- Windows build tools for the Tauri desktop application

Install the Tauri CLI once if it is not available:

```powershell
cargo install tauri-cli --version "^2"
```

## Checks

```powershell
npm install
npm run check
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Keep renderer input untrusted. Backend commands must validate version IDs, paths, URLs and checksums before touching the filesystem or network.
