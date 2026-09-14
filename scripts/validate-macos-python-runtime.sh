#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ARCHIVE="${1:-$SCRIPT_DIR/../src-tauri/python-runtime.tar.gz}"
TARGET_ARCH="${2:-$(uname -m)}"

case "$TARGET_ARCH" in
    arm64|aarch64) TARGET_ARCH="arm64" ;;
    x86_64|x64) TARGET_ARCH="x86_64" ;;
    *)
        echo "[release-resources] ERROR: Unsupported macOS Python target architecture: $TARGET_ARCH" >&2
        exit 1
        ;;
esac

if [ ! -f "$ARCHIVE" ]; then
    echo "[release-resources] ERROR: macOS Python runtime is missing: $ARCHIVE" >&2
    exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openflux-python-validate.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

tar -xzf "$ARCHIVE" -C "$TMP_DIR"

PYTHON_EXE="$TMP_DIR/python/base/bin/python3"
PYTHON_FRAMEWORK="$TMP_DIR/python/Python.framework"
if [ ! -x "$PYTHON_EXE" ]; then
    echo "[release-resources] ERROR: Python executable is missing after extraction: $PYTHON_EXE" >&2
    exit 1
fi

ARCH_ERRORS=0
while IFS= read -r -d '' NATIVE_FILE; do
    FILE_INFO="$(file -b "$NATIVE_FILE")"
    if [[ "$FILE_INFO" == *Mach-O* ]] && [[ "$FILE_INFO" != *"$TARGET_ARCH"* ]]; then
        echo "[release-resources] ERROR: Wrong architecture in $NATIVE_FILE ($FILE_INFO)" >&2
        ARCH_ERRORS=$((ARCH_ERRORS + 1))
    fi
done < <(find "$TMP_DIR/python" -type f \
    \( -path '*/bin/*' -o -name 'Python' -o -name '*.dylib' -o -name '*.so' \) \
    -print0)

if [ "$ARCH_ERRORS" -ne 0 ]; then
    echo "[release-resources] ERROR: Python runtime contains $ARCH_ERRORS incompatible Mach-O file(s)." >&2
    exit 1
fi

codesign --verify --deep --strict "$PYTHON_FRAMEWORK"

RUN_ARCH="$TARGET_ARCH"
PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 arch -"$RUN_ARCH" "$PYTHON_EXE" -c \
    'import bs4, docx, markdownify, openpyxl, pdfminer, PIL, pptx; print("python-runtime-imports=ok")'

codesign --verify --deep --strict "$PYTHON_FRAMEWORK"
echo "[release-resources] macOS Python runtime verified (arch=$TARGET_ARCH, archive=$ARCHIVE)"
