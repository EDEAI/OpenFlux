#!/usr/bin/env bash
# build-gateway.sh
# Prepare gateway for Tauri bundling (macOS/Linux version)
# Creates a production-ready gateway directory with flat node_modules
# (npm instead of pnpm to avoid deep .pnpm symlink nesting)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GATEWAY_DIR="$WORKSPACE_DIR/gateway"
PROD_DIR="$WORKSPACE_DIR/gateway-prod"
BUNDLED_NODE="$WORKSPACE_DIR/src-tauri/node"
VERIFY_DEPENDENCIES="$SCRIPT_DIR/verify-gateway-bundle.mjs"

if [ ! -x "$BUNDLED_NODE" ]; then
    echo "[build-gateway] ERROR: Executable bundled Node is required: $BUNDLED_NODE" >&2
    exit 1
fi
UNAME_S=$(uname -s)
UNAME_M=$(uname -m)
NODE_PLATFORM=$("$BUNDLED_NODE" -p process.platform)
NODE_ARCH=$("$BUNDLED_NODE" -p process.arch)
EXPECTED_ARCH="$UNAME_M"
if [ "$EXPECTED_ARCH" = "x86_64" ]; then EXPECTED_ARCH=x64; fi
if [ "$EXPECTED_ARCH" = "aarch64" ]; then EXPECTED_ARCH=arm64; fi
if [ "$NODE_ARCH" != "$EXPECTED_ARCH" ] || { [ "$UNAME_S" = Darwin ] && [ "$NODE_PLATFORM" != darwin ]; }; then
    echo "[build-gateway] ERROR: Bundled Node $NODE_PLATFORM/$NODE_ARCH does not match shell $UNAME_S/$UNAME_M." >&2
    exit 1
fi
"$BUNDLED_NODE" "$VERIFY_DEPENDENCIES" --verify-lock "$GATEWAY_DIR"
"$BUNDLED_NODE" "$SCRIPT_DIR/validate-embedding-model.mjs"
if [ "$UNAME_S" = Darwin ]; then
    bash "$SCRIPT_DIR/validate-macos-python-runtime.sh" "$WORKSPACE_DIR/src-tauri/python-runtime.tar.gz" "$UNAME_M"
fi
NPM_CLI=$(npm exec --offline --call 'node -p process.env.npm_execpath' | tail -n 1)
if [ ! -f "$NPM_CLI" ]; then
    echo "[build-gateway] ERROR: Could not resolve the installed npm CLI." >&2
    exit 1
fi
export PATH="$(dirname "$BUNDLED_NODE"):$PATH"

echo "[build-gateway] Preparing production gateway bundle..."

# Clean old prod directory
if [ -L "$PROD_DIR" ]; then
    echo "[build-gateway] ERROR: Refusing to clean a symlink: $PROD_DIR" >&2
    exit 1
fi
if [ -d "$PROD_DIR" ]; then
    echo "[build-gateway] Cleaning old gateway-prod..."
    rm -rf "$PROD_DIR"
fi
mkdir -p "$PROD_DIR"

# Copy gateway source
echo "[build-gateway] Copying src/..."
cp -r "$GATEWAY_DIR/src" "$PROD_DIR/src"

# Keep package.json identical to its lock; npm ci omits dev packages itself.
echo "[build-gateway] Copying package.json and package-lock.json..."
cp "$GATEWAY_DIR/package.json" "$GATEWAY_DIR/package-lock.json" "$PROD_DIR/"

# Install production dependencies with npm (flat node_modules, no .pnpm nesting)
echo "[build-gateway] Installing locked production dependencies with bundled Node $("$BUNDLED_NODE" --version)..."
cd "$PROD_DIR"
"$BUNDLED_NODE" "$NPM_CLI" ci --omit=dev --ignore-scripts --no-audit --no-fund 2>&1 | sed 's/^/  /'

# better-sqlite3 needs node-gyp to compile native addon (.node file)
# --ignore-scripts skipped compilation, rebuild separately here
# Use bundled node binary to ensure NODE_MODULE_VERSION matches runtime
echo "[build-gateway] Rebuilding better-sqlite3 with bundled Node..."
"$BUNDLED_NODE" "$NPM_CLI" rebuild better-sqlite3 2>&1 | sed 's/^/  /'

# Detect current platform
echo "[build-gateway] Platform: $UNAME_S / $UNAME_M"

NM="$PROD_DIR/node_modules"

# onnxruntime: keep only current platform binaries
ONNX_ROOT=$("$BUNDLED_NODE" "$VERIFY_DEPENDENCIES" --onnx-root "$PROD_DIR")
ONNX_NODE="$ONNX_ROOT/bin"
if [ -d "$ONNX_NODE" ]; then
    echo "[build-gateway] Cleaning onnxruntime non-platform binaries..."
    if [ "$UNAME_S" = "Darwin" ]; then
        # Keep darwin, remove win32 and linux
        find "$ONNX_NODE" -maxdepth 2 -type d -name "win32" -exec rm -rf {} + 2>/dev/null || true
        find "$ONNX_NODE" -maxdepth 2 -type d -name "linux" -exec rm -rf {} + 2>/dev/null || true
        # onnxruntime-node ships both macOS architectures in the same package.
        # Keep only the architecture that matches the bundled Node runtime.
        for ONNX_NAPI in "$ONNX_NODE"/napi-*; do
            ONNX_DARWIN="$ONNX_NAPI/darwin"
            if [ "$NODE_ARCH" = "arm64" ]; then
                rm -rf "$ONNX_DARWIN/x64"
            else
                rm -rf "$ONNX_DARWIN/arm64"
            fi
        done
    else
        # Linux: keep linux, remove win32 and darwin
        find "$ONNX_NODE" -maxdepth 2 -type d -name "win32" -exec rm -rf {} + 2>/dev/null || true
        find "$ONNX_NODE" -maxdepth 2 -type d -name "darwin" -exec rm -rf {} + 2>/dev/null || true
    fi
fi

# sharp: remove non-current-platform packages (keep pure JS like @img/colour)
IMG_DIR="$NM/@img"
if [ -d "$IMG_DIR" ]; then
    echo "[build-gateway] Cleaning sharp non-platform packages..."
    if [ "$UNAME_S" = "Darwin" ]; then
        # Keep darwin, remove win32 and linux
        find "$IMG_DIR" -maxdepth 1 -type d -name "*win32*" -exec rm -rf {} + 2>/dev/null || true
        find "$IMG_DIR" -maxdepth 1 -type d -name "*linux*" -exec rm -rf {} + 2>/dev/null || true
        find "$IMG_DIR" -maxdepth 1 -type d -name "*android*" -exec rm -rf {} + 2>/dev/null || true
        find "$IMG_DIR" -maxdepth 1 -type d -name "*freebsd*" -exec rm -rf {} + 2>/dev/null || true
        # On Apple Silicon, also remove x64 darwin packages
        if [ "$UNAME_M" = "arm64" ]; then
            find "$IMG_DIR" -maxdepth 1 -type d -name "*darwin-x64*" -exec rm -rf {} + 2>/dev/null || true
        else
            find "$IMG_DIR" -maxdepth 1 -type d -name "*darwin-arm64*" -exec rm -rf {} + 2>/dev/null || true
        fi
    else
        # Linux: keep linux, remove others
        find "$IMG_DIR" -maxdepth 1 -type d -name "*win32*" -exec rm -rf {} + 2>/dev/null || true
        find "$IMG_DIR" -maxdepth 1 -type d -name "*darwin*" -exec rm -rf {} + 2>/dev/null || true
        find "$IMG_DIR" -maxdepth 1 -type d -name "*android*" -exec rm -rf {} + 2>/dev/null || true
        find "$IMG_DIR" -maxdepth 1 -type d -name "*freebsd*" -exec rm -rf {} + 2>/dev/null || true
    fi
fi

# canvas (@napi-rs): remove non-current-platform
NAPI_DIR="$NM/@napi-rs"
if [ -d "$NAPI_DIR" ]; then
    echo "[build-gateway] Cleaning @napi-rs non-platform packages..."
    if [ "$UNAME_S" = "Darwin" ]; then
        find "$NAPI_DIR" -maxdepth 1 -type d -name "*win32*" -exec rm -rf {} + 2>/dev/null || true
        find "$NAPI_DIR" -maxdepth 1 -type d -name "*linux*" -exec rm -rf {} + 2>/dev/null || true
    else
        find "$NAPI_DIR" -maxdepth 1 -type d -name "*win32*" -exec rm -rf {} + 2>/dev/null || true
        find "$NAPI_DIR" -maxdepth 1 -type d -name "*darwin*" -exec rm -rf {} + 2>/dev/null || true
    fi
fi

# onnxruntime-web: not needed for Node runtime
echo "[build-gateway] Removing onnxruntime-web (not needed for Node)..."
rm -rf "$NM/onnxruntime-web" 2>/dev/null || true

# Preserve nested node/common dependencies required by the lock.
echo "[build-gateway] Cleaning nested web runtime..."
HF_INNER="$NM/@huggingface/transformers/node_modules"
if [ -d "$HF_INNER" ]; then
    rm -rf "$HF_INNER/onnxruntime-web" 2>/dev/null || true
fi

# @huggingface/transformers: remove web-only dist files (Node only uses .node.mjs/.node.cjs)
HF_DIST="$NM/@huggingface/transformers/dist"
if [ -d "$HF_DIST" ]; then
    find "$HF_DIST" -type f \( -name "*.web.*" -o -name "*.min.*" \) -delete 2>/dev/null || true
fi

# Package tests are not needed at runtime. In particular, mammoth ships an
# intentionally empty ZIP fixture that Apple cannot expand during notarization.
rm -rf "$NM/mammoth/test" 2>/dev/null || true

# Copy pre-downloaded embedding model to resources/
echo "[build-gateway] Copying embedding model..."
MODEL_SRC="$SCRIPT_DIR/../src-tauri/resources/models"
MODEL_DEST="$PROD_DIR/resources/models"
if [ -d "$MODEL_SRC" ]; then
    mkdir -p "$(dirname "$MODEL_DEST")"
    cp -r "$MODEL_SRC" "$MODEL_DEST"
    echo "[build-gateway] Embedding model copied."
fi

"$BUNDLED_NODE" "$VERIFY_DEPENDENCIES" --verify-bundle "$PROD_DIR"

# Apple notarization recursively inspects archives embedded in an app. Sign all
# Mach-O files before gateway-prod is compressed so native Node modules,
# dynamic libraries and helper executables carry the same Developer ID,
# secure timestamp and hardened-runtime flag as the outer application.
if [ "$UNAME_S" = "Darwin" ]; then
    if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
        echo "[build-gateway] ERROR: APPLE_SIGNING_IDENTITY is required on macOS." >&2
        exit 1
    fi

    echo "[build-gateway] Signing embedded Mach-O files..."
    SIGNED_MACHO_COUNT=0
    while IFS= read -r -d '' NATIVE_FILE; do
        if file -b "$NATIVE_FILE" | grep -q "Mach-O"; then
            codesign --force \
                --sign "$APPLE_SIGNING_IDENTITY" \
                --timestamp \
                --options runtime \
                "$NATIVE_FILE"
            codesign --verify --strict --verbose=2 "$NATIVE_FILE"
            SIGNED_MACHO_COUNT=$((SIGNED_MACHO_COUNT + 1))
        fi
    done < <(find "$PROD_DIR" -type f -print0)
    echo "[build-gateway] Signed $SIGNED_MACHO_COUNT embedded Mach-O files."
fi

# Report size
TOTAL=$(du -sm "$PROD_DIR" | awk '{print $1}')
echo "[build-gateway] Production gateway size: ${TOTAL}MB"

# Package as tar.gz for Tauri bundling
echo "[build-gateway] Packaging gateway-bundle.tar.gz..."
# A local rebuild can keep the same app version. Give each bundle a marker so
# setup_gateway_runtime replaces the previously extracted Gateway on launch.
printf '%s-%s-%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" "$UNAME_S" "$UNAME_M" > "$PROD_DIR/gateway-build-id.txt"
TAR_OUTPUT="$SCRIPT_DIR/../src-tauri/gateway-bundle.tar.gz"
rm -f "$TAR_OUTPUT"
tar -czf "$TAR_OUTPUT" -C "$PROD_DIR" .
TAR_SIZE=$(du -sm "$TAR_OUTPUT" | awk '{print $1}')
echo "[build-gateway] Done! gateway-bundle.tar.gz: ${TAR_SIZE}MB"
