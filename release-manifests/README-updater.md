# OpenFlux signed updater

OpenFlux keeps two release feeds during the bridge period:

- `openflux.json`: legacy announcement feed. Do not change the existing field types; clients from 0.6.20 parse `notes` as an array.
- `openflux-updater.json`: signed Tauri updater feed used by 1.0.1 and later after the user confirms the update.

The first bridge release is `1.0.1`. Older clients install it through the existing manual-download flow. Future releases use the signed updater feed and require only one confirmation.

## Local build

The updater signing private key is intentionally not stored in this repository. Load the local key only into the build process. Keep a protected key password in the CI secret store:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw -LiteralPath 'C:\secure-location\openflux-updater.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<read this from your CI secret store>'
pnpm tauri:build
```

The release build generates the NSIS updater artifact and its `.sig` file because `tauri.signing.conf.json` enables `createUpdaterArtifacts`.

Copy `openflux-updater.example.json` to a staging manifest and replace the URL and signature with the exact generated artifact values. Do not upload the example file.

For a loopback-only integration test, launch Tauri with the explicit local overlay:

```powershell
pnpm tauri dev --config src-tauri/tauri.local-updater.conf.json
```

Then set both dev feeds from the WebView console. The Rust command accepts plain HTTP only for loopback hosts in debug builds:

```javascript
__setUpdateFeed('http://127.0.0.1:8787/openflux.json')
__setSignedUpdateFeed('http://127.0.0.1:8787/openflux-updater.json')
```

Do not set `dangerousInsecureTransportProtocol` in a production overlay.

To verify updater artifacts without invoking the Azure production-signing command, use the local build overlay explicitly:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw -LiteralPath 'C:\secure-location\openflux-updater.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<read this from your local secret store>'
pnpm tauri build --bundles nsis --config src-tauri/tauri.local-build.conf.json
```

## macOS release build

macOS release packages must be built on macOS with a `Developer ID Application`
certificate and Apple notarization credentials. The Windows Azure certificate does
not apply to macOS.

Build the two architectures independently. The embedded `src-tauri/node` executable
and native gateway dependencies must match the target architecture; do not reuse an
ARM gateway bundle for an Intel build, or an Intel bundle for an ARM build.

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin

# Apple Silicon build, with an arm64 src-tauri/node in place
pnpm tauri build --bundles dmg --target aarch64-apple-darwin \
  --config src-tauri/tauri.macos.conf.json

# Intel build, with an x64 src-tauri/node and x64 Node/npm environment in place
pnpm tauri build --bundles dmg --target x86_64-apple-darwin \
  --config src-tauri/tauri.macos.conf.json
```

`tauri.macos.conf.json` enables updater artifact generation. Each architecture must
produce both its DMG and `OpenFlux.app.tar.gz` updater bundle with the matching
`.sig`. The static signed manifest keys are `darwin-aarch64` and
`darwin-x86_64`; their URLs point to the `.app.tar.gz` files, while the legacy
`openflux.json` download URLs continue to point to the two DMGs.

Before handing off artifacts, verify each build:

```bash
codesign --verify --deep --strict --verbose=2 OpenFlux.app
spctl --assess --type execute --verbose=4 OpenFlux.app
xcrun stapler validate OpenFlux.app
```
