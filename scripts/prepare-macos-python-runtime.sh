#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_ARCHIVE="${OPENFLUX_PYTHON_RUNTIME_SOURCE:-}"
OUTPUT_ARCHIVE="${OPENFLUX_PYTHON_RUNTIME_OUTPUT:-$SCRIPT_DIR/../src-tauri/python-runtime.tar.gz}"
TARGET_ARCH="${OPENFLUX_TARGET_ARCH:-$(uname -m)}"
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"

case "$TARGET_ARCH" in
    arm64|aarch64) TARGET_ARCH="arm64" ;;
    x86_64|x64) TARGET_ARCH="x86_64" ;;
    *)
        echo "[python-runtime] ERROR: Unsupported target architecture: $TARGET_ARCH" >&2
        exit 1
        ;;
esac

if [ -z "$SOURCE_ARCHIVE" ] || [ ! -f "$SOURCE_ARCHIVE" ]; then
    echo "[python-runtime] ERROR: Set OPENFLUX_PYTHON_RUNTIME_SOURCE to a seed python-runtime.tar.gz" >&2
    exit 1
fi
if [ -z "$SIGNING_IDENTITY" ]; then
    echo "[python-runtime] ERROR: APPLE_SIGNING_IDENTITY is required" >&2
    exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openflux-python-build.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

tar -xzf "$SOURCE_ARCHIVE" -C "$TMP_DIR"
PYTHON_ROOT="$TMP_DIR/python"
PYTHON_EXE="$PYTHON_ROOT/base/bin/python3"
PYTHON_FRAMEWORK="$PYTHON_ROOT/Python.framework"

if [ ! -x "$PYTHON_EXE" ]; then
    echo "[python-runtime] ERROR: Seed archive does not contain python/base/bin/python3" >&2
    exit 1
fi
if ! file -b "$PYTHON_EXE" | grep -q "$TARGET_ARCH"; then
    echo "[python-runtime] ERROR: Seed Python does not contain architecture $TARGET_ARCH" >&2
    file "$PYTHON_EXE" >&2
    exit 1
fi

echo "[python-runtime] Installing pinned document dependencies for $TARGET_ARCH..."
PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 arch -"$TARGET_ARCH" "$PYTHON_EXE" \
    -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: \
    --upgrade --force-reinstall \
    'beautifulsoup4==4.14.3' \
    'cffi==2.0.0' \
    'charset-normalizer==3.5.1' \
    'cryptography==48.0.0' \
    'et-xmlfile==2.0.0' \
    'lxml==6.1.0' \
    'markdownify==1.2.2' \
    'openpyxl==3.1.5' \
    'pdfminer.six==20260107' \
    'pillow==12.2.0' \
    'pycparser==3.0' \
    'python-docx==1.2.0' \
    'python-pptx==1.0.2' \
    'six==1.17.0' \
    'soupsieve==2.9.2' \
    'typing-extensions==4.16.0' \
    'xlsxwriter==3.2.9'

# Keep the signed runtime immutable when it is executed from app data.
find "$PYTHON_ROOT" -type d -name '__pycache__' -prune -exec rm -rf {} +
find "$PYTHON_ROOT" -type f \( -name '*.pyc' -o -name '._*' \) -delete

echo "[python-runtime] Signing embedded Mach-O files..."
while IFS= read -r -d '' NATIVE_FILE; do
    if file -b "$NATIVE_FILE" | grep -q 'Mach-O'; then
        codesign --force \
            --sign "$SIGNING_IDENTITY" \
            --timestamp \
            --options runtime \
            "$NATIVE_FILE"
    fi
done < <(find "$PYTHON_ROOT" -type f \
    \( -path '*/bin/*' -o -name 'Python' -o -name '*.dylib' -o -name '*.so' \) \
    -print0)

codesign --force --deep \
    --sign "$SIGNING_IDENTITY" \
    --timestamp \
    --options runtime \
    "$PYTHON_FRAMEWORK"

mkdir -p "$(dirname "$OUTPUT_ARCHIVE")"
rm -f "$OUTPUT_ARCHIVE"
COPYFILE_DISABLE=1 tar -czf "$OUTPUT_ARCHIVE" -C "$TMP_DIR" python

"$SCRIPT_DIR/validate-macos-python-runtime.sh" "$OUTPUT_ARCHIVE" "$TARGET_ARCH"
echo "[python-runtime] Ready: $OUTPUT_ARCHIVE"
