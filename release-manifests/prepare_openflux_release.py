"""Prepare and validate a complete OpenFlux website/updater release locally.

This command never uploads anything. It combines the existing Windows updater
entry with the two macOS updater entries, refreshes the legacy announcement
manifest, validates all signatures/artifacts, and writes an upload plan that can
later be consumed by ``upload_manifests.py``.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import plistlib
import shutil
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent
PRODUCT = "OpenFlux"
IDENTIFIER = "com.openflux.app"
PLATFORMS = {"windows-x86_64", "darwin-aarch64", "darwin-x86_64"}


def fail(message: str) -> None:
    raise RuntimeError(message)


def read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        fail(f"invalid JSON: {path}: {exc}")


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def decode_public_key(outer: str) -> tuple[bytes, bytes, str]:
    try:
        inner = base64.b64decode(outer.strip(), validate=True).decode("utf-8")
        lines = inner.splitlines()
        raw = base64.b64decode(lines[1], validate=True)
    except Exception as exc:
        fail(f"invalid Tauri updater public key: {exc}")
    if len(lines) != 2 or len(raw) != 42 or raw[:2] not in (b"Ed", b"ED"):
        fail("invalid minisign public key shape")
    return raw[2:10], raw[10:42], inner


def public_key_id(outer: str) -> str:
    key_id, _, _ = decode_public_key(outer)
    return key_id[::-1].hex().upper()


def verify_signature(artifact: Path, signature_path: Path, public_key_outer: str) -> None:
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError as exc:
        fail("cryptography is required for release signature verification")

    signature_outer = signature_path.read_text(encoding="utf-8").strip()
    try:
        signature_inner = base64.b64decode(signature_outer, validate=True).decode("utf-8")
        lines = signature_inner.splitlines()
        signature_raw = base64.b64decode(lines[1], validate=True)
        global_signature = base64.b64decode(lines[3], validate=True)
    except Exception as exc:
        fail(f"invalid updater signature file {signature_path}: {exc}")
    if len(lines) != 4 or len(signature_raw) != 74 or len(global_signature) != 64:
        fail(f"invalid minisign signature shape: {signature_path}")
    if not lines[2].startswith("trusted comment: "):
        fail(f"missing trusted comment: {signature_path}")

    public_id, public_bytes, _ = decode_public_key(public_key_outer)
    signature_algorithm = signature_raw[:2]
    signature_id = signature_raw[2:10]
    signature_bytes = signature_raw[10:74]
    if signature_algorithm != b"ED" or signature_id != public_id:
        fail(f"signature key/algorithm mismatch: {signature_path}")

    digest = hashlib.blake2b(digest_size=64)
    with artifact.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    trusted_comment = lines[2][len("trusted comment: ") :].encode("utf-8")
    verifier = Ed25519PublicKey.from_public_bytes(public_bytes)
    try:
        verifier.verify(signature_bytes, digest.digest())
        verifier.verify(global_signature, signature_bytes + trusted_comment)
    except Exception as exc:
        fail(f"cryptographic updater signature verification failed: {artifact}: {exc}")


def file_contains(path: Path, needle: bytes) -> bool:
    overlap = b""
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            data = overlap + chunk
            if needle in data:
                return True
            overlap = data[-max(1, len(needle) - 1) :]
    return needle in overlap


def verify_windows(
    installer: Path,
    signature_path: Path,
    public_key_outer: str,
) -> None:
    if not installer.is_file() or not signature_path.is_file():
        fail("Windows installer or updater signature is missing")
    verify_signature(installer, signature_path, public_key_outer)
    if not file_contains(installer, public_key_outer.encode("utf-8")):
        fail("Windows installer does not embed the configured Windows updater public key")


def verify_dmg(path: Path) -> None:
    if not path.is_file() or path.stat().st_size < 512:
        fail(f"invalid or missing DMG: {path}")
    with path.open("rb") as handle:
        handle.seek(-512, 2)
        if handle.read(4) != b"koly":
            fail(f"DMG is missing its UDIF trailer: {path}")


def verify_mac_bundle(
    archive: Path,
    signature_path: Path,
    public_key_outer: str,
    expected_arch: str,
    version: str,
) -> None:
    if not archive.is_file() or not signature_path.is_file():
        fail(f"macOS updater archive or signature is missing: {archive}")
    verify_signature(archive, signature_path, public_key_outer)

    info: dict[str, Any] | None = None
    main_arch: str | None = None
    public_key_seen = False
    roots: set[str] = set()
    junk: list[str] = []
    public_key_needle = public_key_outer.encode("utf-8")
    executable_path = f"{PRODUCT}.app/Contents/MacOS/openflux-rust"

    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle:
            name = member.name.lstrip("./")
            if name:
                roots.add(name.split("/", 1)[0])
            lowered = name.lower()
            if (
                "__macosx" in lowered
                or lowered.endswith(".ds_store")
                or lowered.endswith(".bak")
                or "manifest.xml.bak" in lowered
            ):
                junk.append(name)
            if name.endswith("/Contents/Info.plist") and member.isfile():
                handle = bundle.extractfile(member)
                if handle is not None:
                    info = plistlib.loads(handle.read())
            if name == executable_path and member.isfile():
                handle = bundle.extractfile(member)
                if handle is None:
                    continue
                head = handle.read(8)
                if len(head) < 8 or head[:4] != bytes.fromhex("cffaedfe"):
                    fail(f"unexpected Mach-O header in {archive}")
                cpu_type = int.from_bytes(head[4:8], "little")
                main_arch = {0x0100000C: "arm64", 0x01000007: "x86_64"}.get(cpu_type)
                overlap = head
                while chunk := handle.read(4 * 1024 * 1024):
                    data = overlap + chunk
                    if public_key_needle in data:
                        public_key_seen = True
                    overlap = data[-max(1, len(public_key_needle) - 1) :]
                if public_key_needle in overlap:
                    public_key_seen = True

    if roots != {f"{PRODUCT}.app"}:
        fail(f"unexpected roots in {archive}: {sorted(roots)}")
    if junk:
        fail(f"backup/junk files found in {archive}: {junk}")
    if info is None:
        fail(f"Info.plist is missing from {archive}")
    if info.get("CFBundleIdentifier") != IDENTIFIER:
        fail(f"wrong bundle identifier in {archive}: {info.get('CFBundleIdentifier')}")
    if info.get("CFBundleShortVersionString") != version:
        fail(f"wrong app version in {archive}: {info.get('CFBundleShortVersionString')}")
    if main_arch != expected_arch:
        fail(f"wrong architecture in {archive}: expected {expected_arch}, got {main_arch}")
    if not public_key_seen:
        fail(f"macOS app does not embed its supplied updater public key: {archive}")


def make_entry(path: Path, output_root: Path, oss_key: str, role: str, content_type: str) -> dict[str, Any]:
    relative = path.relative_to(output_root).as_posix()
    return {
        "local_path": relative,
        "oss_key": oss_key,
        "role": role,
        "content_type": content_type,
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", default="1.0.3")
    parser.add_argument("--release-date", default="2026-09-04")
    parser.add_argument(
        "--artifact-base-url",
        default="https://openflux-release.oss-cn-hangzhou.aliyuncs.com/release",
    )
    parser.add_argument("--mac-release-dir", type=Path, required=True)
    parser.add_argument("--mac-public-key", type=Path, required=True)
    parser.add_argument(
        "--windows-installer",
        type=Path,
        default=REPO_ROOT / "output" / "OpenFlux_1.0.3_x64-setup.exe",
    )
    parser.add_argument(
        "--windows-public-key-config",
        type=Path,
        default=REPO_ROOT / "src-tauri" / "tauri.conf.json",
    )
    parser.add_argument(
        "--windows-updater-manifest",
        type=Path,
        default=ROOT / "openflux-updater.json",
    )
    parser.add_argument(
        "--legacy-manifest",
        type=Path,
        default=ROOT / "openflux.json",
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    version = args.version
    output_root = args.output_dir.resolve()
    if output_root.exists():
        fail(f"output directory already exists; choose a fresh path: {output_root}")

    mac_release_dir = args.mac_release_dir.resolve()
    windows_installer = args.windows_installer.resolve()
    windows_signature = Path(str(windows_installer) + ".sig")
    windows_manifest = read_json(args.windows_updater_manifest.resolve())
    legacy_manifest = read_json(args.legacy_manifest.resolve())
    windows_config = read_json(args.windows_public_key_config.resolve())
    windows_public_key = windows_config["plugins"]["updater"]["pubkey"].strip()
    mac_public_key = args.mac_public_key.resolve().read_text(encoding="utf-8").strip()
    mac_manifest_path = mac_release_dir / "openflux-updater.json"
    mac_manifest = read_json(mac_manifest_path) if mac_manifest_path.is_file() else {}
    if mac_manifest:
        if mac_manifest.get("version") != version:
            fail("macOS updater manifest version does not match requested version")
        if set(mac_manifest.get("platforms", {})) != {"darwin-aarch64", "darwin-x86_64"}:
            fail("macOS handoff manifest must contain exactly the two darwin platforms")

    expected = {
        "darwin-aarch64": ("arm64", f"OpenFlux_{version}_aarch64"),
        "darwin-x86_64": ("x86_64", f"OpenFlux_{version}_x64"),
    }
    mac_files: dict[str, tuple[Path, Path, Path]] = {}
    for platform, (architecture, stem) in expected.items():
        dmg = mac_release_dir / f"{stem}.dmg"
        archive = mac_release_dir / f"{stem}.app.tar.gz"
        signature = mac_release_dir / f"{stem}.app.tar.gz.sig"
        if mac_manifest:
            manifest_entry = mac_manifest["platforms"][platform]
            if Path(manifest_entry.get("url", "")).name != archive.name:
                fail(f"macOS manifest URL does not match artifact for {platform}")
            if manifest_entry.get("signature", "").strip() != signature.read_text(encoding="utf-8").strip():
                fail(f"macOS manifest signature does not match .sig for {platform}")
        verify_dmg(dmg)
        verify_mac_bundle(archive, signature, mac_public_key, architecture, version)
        mac_files[platform] = (dmg, archive, signature)

    verify_windows(
        windows_installer,
        windows_signature,
        windows_public_key,
    )

    artifact_base_url = args.artifact_base_url.rstrip("/")
    merged_updater = {
        "version": version,
        "notes": windows_manifest.get("notes", "OpenFlux updater release."),
        "pub_date": mac_manifest.get("pub_date")
        or windows_manifest.get("pub_date")
        or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "platforms": {
            "windows-x86_64": {
                "signature": windows_signature.read_text(encoding="utf-8").strip(),
            },
        },
    }
    merged_updater["platforms"]["windows-x86_64"]["url"] = (
        f"{artifact_base_url}/{windows_installer.name}"
    )
    for platform in ("darwin-aarch64", "darwin-x86_64"):
        _, archive, signature = mac_files[platform]
        merged_updater["platforms"][platform] = {
            "signature": signature.read_text(encoding="utf-8").strip(),
            "url": f"{artifact_base_url}/{archive.name}",
        }
    if set(merged_updater["platforms"]) != PLATFORMS:
        fail("merged updater manifest does not contain all required platforms")

    legacy = dict(legacy_manifest)
    legacy.update(
        {
            "brandId": "openflux",
            "channel": "stable",
            "version": version,
            "releaseDate": args.release_date,
            "notes": [
                "修复长会话上下文预算与压缩边界问题，提升持续任务稳定性",
                "优化演示文稿的容量规划、文字适配、渲染与导出可靠性",
                "改进会话标题和工具日志摘要，恢复历史任务时信息更清晰",
                "增强大数据读取、分页续读及 Office 操作结果处理",
                "优化失败重试、超时终止与任务收敛，减少重复执行",
            ],
            "notesUrl": "https://openflux.io/download",
            "downloadPage": "https://openflux.io/download",
            "downloads": {
                "windows-x64": {
                    "url": f"{artifact_base_url}/{windows_installer.name}",
                    "sha256": sha256_file(windows_installer),
                },
                "darwin-aarch64": {
                    "url": f"{artifact_base_url}/{mac_files['darwin-aarch64'][0].name}",
                    "sha256": sha256_file(mac_files["darwin-aarch64"][0]),
                },
                "darwin-x64": {
                    "url": f"{artifact_base_url}/{mac_files['darwin-x86_64'][0].name}",
                    "sha256": sha256_file(mac_files["darwin-x86_64"][0]),
                },
            },
        }
    )

    release_dir = output_root / "release"
    manifests_dir = release_dir / "manifests"
    manifests_dir.mkdir(parents=True)

    staged: list[tuple[Path, str, str, str]] = []
    source_files = [
        (windows_installer, windows_installer.name, "artifact", "application/vnd.microsoft.portable-executable"),
        (windows_signature, windows_signature.name, "artifact_signature", "text/plain; charset=utf-8"),
    ]
    for platform in ("darwin-aarch64", "darwin-x86_64"):
        dmg, archive, signature = mac_files[platform]
        source_files.extend(
            [
                (dmg, dmg.name, "artifact", "application/x-apple-diskimage"),
                (archive, archive.name, "artifact", "application/gzip"),
                (signature, signature.name, "artifact_signature", "text/plain; charset=utf-8"),
            ]
        )
    for source, name, role, content_type in source_files:
        destination = release_dir / name
        shutil.copy2(source, destination)
        staged.append((destination, f"release/{name}", role, content_type))

    updater_path = manifests_dir / "openflux-updater.json"
    legacy_path = manifests_dir / "openflux.json"
    write_json(updater_path, merged_updater)
    write_json(legacy_path, legacy)
    staged.extend(
        [
            (updater_path, "release/manifests/openflux-updater.json", "signed_manifest", "application/json; charset=utf-8"),
            (legacy_path, "release/manifests/openflux.json", "announcement_manifest", "application/json; charset=utf-8"),
        ]
    )

    plan_entries = [make_entry(path, output_root, oss_key, role, content_type) for path, oss_key, role, content_type in staged]
    plan = {
        "schema": 1,
        "product": "openflux",
        "version": version,
        "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "upload_order": ["artifact", "artifact_signature", "signed_manifest", "announcement_manifest"],
        "files": plan_entries,
    }
    write_json(output_root / "UPLOAD_PLAN.json", plan)

    checksum_lines = [f"{entry['sha256']}  {entry['local_path']}" for entry in plan_entries]
    (output_root / "SHA256SUMS.txt").write_text(
        "\n".join(checksum_lines) + "\n", encoding="utf-8", newline="\n"
    )
    validation = {
        "version": version,
        "platforms": sorted(PLATFORMS),
        "windows_updater_key_id": public_key_id(windows_public_key),
        "macos_updater_key_id": public_key_id(mac_public_key),
        "platform_specific_updater_keys": windows_public_key != mac_public_key,
        "updater_signatures_verified": True,
        "bundle_identifiers_verified": True,
        "architectures_verified": True,
        "private_material_included": False,
        "online_changes_performed": False,
        "macos_gate": "Run codesign, spctl and stapler validation on macOS before --execute.",
    }
    write_json(output_root / "VALIDATION.json", validation)
    (output_root / "README_UPLOAD.md").write_text(
        f"""# OpenFlux {version} website/updater upload package

This directory contains public release artifacts only. It contains no updater
private key, Apple credential, OSS credential, or server password.

The upload plan deliberately uploads versioned artifacts first, the signed
updater manifest second, and the legacy announcement manifest last. Do not move
the JSON files out of `release/manifests/`; clients fetch them from that path.

Before the real upload, a Mac owner must record successful `codesign --verify`,
`spctl --assess`, and `xcrun stapler validate` results for both Mac builds.

Dry run from the OpenFlux-Rust repository:

```powershell
python release-manifests/upload_manifests.py --plan <this-directory>/UPLOAD_PLAN.json
```

The uploader performs no network writes unless `--execute` and the matching
`--confirm-version` value are both supplied.
""",
        encoding="utf-8",
        newline="\n",
    )

    print(f"PREPARE_OK: {output_root}")
    print(f"files={len(plan_entries)} version={version}")
    print(f"windows_key={validation['windows_updater_key_id']}")
    print(f"macos_key={validation['macos_updater_key_id']}")
    print("online_changes_performed=false")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"PREPARE_ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
