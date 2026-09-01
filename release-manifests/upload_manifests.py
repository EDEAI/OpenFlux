"""Validate or upload a prepared release plan to Aliyun OSS.

The default mode is a local dry run. Network writes require both ``--execute``
and ``--confirm-version``. Artifacts are always uploaded before manifests so a
client can never discover a release whose package is still missing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any


ROLE_ORDER = {
    "artifact": 0,
    "artifact_signature": 1,
    "signed_manifest": 2,
    "announcement_manifest": 3,
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True, help="UPLOAD_PLAN.json from prepare_openflux_release.py")
    parser.add_argument("--execute", action="store_true", help="perform the OSS writes; omitted means dry run")
    parser.add_argument("--confirm-version", help="must exactly match the plan version when --execute is used")
    return parser.parse_args()


def load_and_validate_plan(plan_path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    plan_path = plan_path.resolve()
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if plan.get("schema") != 1 or not plan.get("version"):
        raise RuntimeError("unsupported or incomplete upload plan")
    plan_root = plan_path.parent
    files = plan.get("files")
    if not isinstance(files, list) or not files:
        raise RuntimeError("upload plan contains no files")

    validated: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for entry in files:
        role = entry.get("role")
        oss_key = str(entry.get("oss_key", ""))
        relative = Path(str(entry.get("local_path", "")))
        if role not in ROLE_ORDER:
            raise RuntimeError(f"unknown upload role: {role}")
        if not oss_key.startswith("release/") or oss_key in seen_keys:
            raise RuntimeError(f"invalid or duplicate OSS key: {oss_key}")
        lowered = f"{relative.as_posix()} {oss_key}".lower()
        if "private" in lowered or lowered.endswith(".key"):
            raise RuntimeError(f"refusing to include private key material: {relative}")
        path = (plan_root / relative).resolve()
        if plan_root not in path.parents:
            raise RuntimeError(f"file escapes plan directory: {relative}")
        if not path.is_file():
            raise RuntimeError(f"planned file is missing: {path}")
        if path.stat().st_size != int(entry.get("bytes", -1)):
            raise RuntimeError(f"size mismatch: {path}")
        actual_hash = sha256_file(path)
        if actual_hash.lower() != str(entry.get("sha256", "")).lower():
            raise RuntimeError(f"SHA-256 mismatch: {path}")
        item = dict(entry)
        item["path"] = path
        validated.append(item)
        seen_keys.add(oss_key)

    validated.sort(key=lambda item: (ROLE_ORDER[item["role"]], item["oss_key"]))
    if validated[-1]["role"] != "announcement_manifest":
        raise RuntimeError("legacy announcement manifest must be uploaded last")
    return plan, validated


def upload(plan: dict[str, Any], files: list[dict[str, Any]]) -> None:
    access_key_id = os.environ.get("OSS_ACCESS_KEY_ID", "").strip()
    access_key_secret = os.environ.get("OSS_ACCESS_KEY_SECRET", "").strip()
    endpoint = os.environ.get("OSS_ENDPOINT", "https://oss-cn-hangzhou.aliyuncs.com").strip()
    bucket_name = os.environ.get("OSS_BUCKET", "openflux-release").strip()
    if not access_key_id or not access_key_secret:
        raise RuntimeError("set OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET before --execute")

    try:
        import oss2
    except ImportError as exc:
        raise RuntimeError("oss2 is required for --execute") from exc

    auth = oss2.Auth(access_key_id, access_key_secret)
    bucket = oss2.Bucket(auth, endpoint, bucket_name)

    for entry in files:
        path: Path = entry["path"]
        key = entry["oss_key"]
        headers = {"Content-Type": entry["content_type"]}
        print(f"UPLOAD {entry['role']}: {path.name} -> oss://{bucket_name}/{key}")
        if path.stat().st_size >= 16 * 1024 * 1024:
            oss2.resumable_upload(bucket, key, str(path), headers=headers, num_threads=4)
        else:
            bucket.put_object_from_file(key, str(path), headers=headers)
        remote = bucket.head_object(key)
        if int(remote.content_length) != path.stat().st_size:
            raise RuntimeError(f"remote size mismatch after upload: {key}")
        print(f"OK https://{bucket_name}.oss-cn-hangzhou.aliyuncs.com/{key}")

    print(f"UPLOAD_DONE product={plan.get('product')} version={plan['version']}")


def main() -> int:
    args = parse_args()
    plan, files = load_and_validate_plan(args.plan)
    print(f"PLAN_OK product={plan.get('product')} version={plan['version']} files={len(files)}")
    for entry in files:
        print(f"{entry['role']:21} {entry['oss_key']} ({entry['bytes']} bytes)")

    if not args.execute:
        print("DRY_RUN_ONLY: no network writes were performed")
        return 0
    if args.confirm_version != plan["version"]:
        raise RuntimeError("--confirm-version must exactly match the plan version")
    upload(plan, files)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
