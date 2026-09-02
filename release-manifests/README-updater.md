# OpenFlux signed updater

OpenFlux keeps two release feeds during the bridge period:

- `openflux.json`: legacy announcement feed. Do not change the existing field types; clients from 0.6.20 parse `notes` as an array.
- `openflux-updater.json`: signed Tauri updater feed used by 1.0.1 and later after the user confirms the update.

The first bridge release is `1.0.1`. Older clients install it through the existing manual-download flow. Future releases use the signed updater feed and require only one confirmation.

## Production release policy

Every stable version is one indivisible cross-platform release. Before either
online manifest is changed, the exact same version must be built and validated
for all of these targets:

- Windows x64: enterprise-signed NSIS installer and updater signature
- macOS Apple Silicon: Developer ID signed, notarized and stapled DMG, updater
  archive and updater signature
- macOS Intel: Developer ID signed, notarized and stapled DMG, updater archive
  and updater signature

Partial platform releases are not allowed. If any target is missing or fails
validation, keep both online manifests on the previous version. Do not publish
Windows first and add either Mac build later under the same version number. If a
published artifact must be replaced, build and publish a new patch version.

After all targets pass, upload versioned artifacts and their signatures first,
the signed updater manifest second, and the legacy announcement manifest last.
The preparation script enforces the complete three-platform artifact set and the
uploader preserves this order.

## Local build

Updater signing private keys are intentionally not stored in this repository. The
1.0.1 bridge release has platform-specific official keys: Windows keeps the key
embedded in `tauri.conf.json`, while macOS uses the key whose public half is
declared by `tauri.macos.conf.json`. This preserves already-installed Windows
1.0.1 clients and the shipped Mac 1.0.1 packages. Load only the private key for
the platform being built, and keep its password in the CI secret store:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw -LiteralPath 'C:\secure-location\openflux-updater.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<read this from your CI secret store>'
pnpm tauri:build
```

The release build generates the NSIS updater artifact and its `.sig` file because `tauri.signing.conf.json` enables `createUpdaterArtifacts`.

Copy `openflux-updater.example.json` to a staging manifest and replace the URL and signature with the exact generated artifact values. Do not upload the example file. A production static manifest must retain all three keys: `windows-x86_64`, `darwin-aarch64`, and `darwin-x86_64`.

## Prepare the website/updater upload package

Use the local-only preparation command to verify the Windows and Mac signatures,
architectures, identifiers, embedded public keys, DMG structure, manifest merge,
and hashes. It writes a fresh staging directory and performs no network writes:

```powershell
python release-manifests/prepare_openflux_release.py `
  --mac-release-dir 'output\openflux-1.0.2-macos-final-notarized\release-input' `
  --mac-public-key 'output\openflux-1.0.2-macos-final-notarized\openflux-updater.key.pub' `
  --output-dir 'output\openflux-official-release-1.0.2-final-local'
```

The generated directory mirrors the actual OSS keys:

- installers and updater archives: `release/`
- the legacy and signed JSON feeds: `release/manifests/`

The upload command is a dry run unless both execution switches are supplied:

```powershell
# validation/dry run only
python release-manifests/upload_manifests.py `
  --plan 'output\openflux-official-release-1.0.2-final-local\UPLOAD_PLAN.json'

# real publication — run only after Mac codesign/notarization acceptance
python release-manifests/upload_manifests.py `
  --plan 'output\openflux-official-release-1.0.2-final-local\UPLOAD_PLAN.json' `
  --execute --confirm-version 1.0.2
```

The uploader validates every SHA-256 and rejects private-key paths. It uploads all
versioned artifacts first, then `openflux-updater.json`, and finally
`openflux.json`, so old clients are never notified before the packages exist.

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

Do not sign a Mac updater archive with the Windows private key by default. The
macOS overlay contains the Mac public key that is already embedded in the shipped
1.0.1 Mac applications; future Mac updater archives must be signed by its matching
private key. Likewise, future Windows updater installers must continue to use the
Windows private key trusted by installed Windows 1.0.1 clients.

Before handing off artifacts, verify each build:

```bash
codesign --verify --deep --strict --verbose=2 OpenFlux.app
spctl --assess --type execute --verbose=4 OpenFlux.app
xcrun stapler validate OpenFlux.app
```
