#!/usr/bin/env bash
# build-gateway.sh
# Prepare gateway for Tauri bundling (macOS/Linux version)
# Creates a production-ready gateway directory with flat node_modules
# (npm instead of pnpm to avoid deep .pnpm symlink nesting)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATEWAY_DIR="$SCRIPT_DIR/../gateway"
PROD_DIR="$SCRIPT_DIR/../gateway-prod"

echo "[build-gateway] Preparing production gateway bundle..."

# Clean old prod directory
if [ -d "$PROD_DIR" ]; then
    echo "[build-gateway] Cleaning old gateway-prod..."
    rm -rf "$PROD_DIR"
fi
mkdir -p "$PROD_DIR"

# Copy gateway source
echo "[build-gateway] Copying src/..."
cp -r "$GATEWAY_DIR/src" "$PROD_DIR/src"

# Copy package.json (remove devDependencies for npm install)
echo "[build-gateway] Copying package.json..."
node -e "
const pkg = JSON.parse(require('fs').readFileSync('$GATEWAY_DIR/package.json', 'utf8'));
delete pkg.devDependencies;
require('fs').writeFileSync('$PROD_DIR/package.json', JSON.stringify(pkg, null, 2));
"

# Install production dependencies with npm (flat node_modules, no .pnpm nesting)
echo "[build-gateway] Installing production dependencies with npm..."
cd "$PROD_DIR"
npm install --omit=dev --ignore-scripts 2>&1 | sed 's/^/  /'

# tsx is needed at runtime to execute TypeScript source
echo "[build-gateway] Installing tsx..."
npm install tsx@4.21.0 2>&1 | sed 's/^/  /'

# better-sqlite3 needs node-gyp to compile native addon (.node file)
# --ignore-scripts skipped compilation, rebuild separately here
# Use bundled node binary to ensure NODE_MODULE_VERSION matches runtime
BUNDLED_NODE="$SCRIPT_DIR/../src-tauri/node"
if [ -x "$BUNDLED_NODE" ]; then
    BUNDLED_NODE_VERSION=$("$BUNDLED_NODE" --version)
    echo "[build-gateway] Rebuilding better-sqlite3 with bundled Node $BUNDLED_NODE_VERSION..."
    BUNDLED_NODE_DIR=$(dirname "$BUNDLED_NODE")
    export PATH="$BUNDLED_NODE_DIR:$PATH"
    npm rebuild better-sqlite3 2>&1 | sed 's/^/  /'
else
    echo "[build-gateway] WARNING: Bundled node not found at $BUNDLED_NODE, using system node"
    echo "[build-gateway] Rebuilding better-sqlite3 native addon..."
    npm rebuild better-sqlite3 2>&1 | sed 's/^/  /'
fi

# Detect current platform
UNAME_S=$(uname -s)
UNAME_M=$(uname -m)
echo "[build-gateway] Platform: $UNAME_S / $UNAME_M"

NM="$PROD_DIR/node_modules"

# onnxruntime: keep only current platform binaries
ONNX_NODE="$NM/onnxruntime-node/bin"
if [ -d "$ONNX_NODE" ]; then
    echo "[build-gateway] Cleaning onnxruntime non-platform binaries..."
    if [ "$UNAME_S" = "Darwin" ]; then
        # Keep darwin, remove win32 and linux
        find "$ONNX_NODE" -maxdepth 2 -type d -name "win32" -exec rm -rf {} + 2>/dev/null || true
        find "$ONNX_NODE" -maxdepth 2 -type d -name "linux" -exec rm -rf {} + 2>/dev/null || true
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

# @huggingface/transformers may nest its own onnxruntime copies
echo "[build-gateway] Cleaning nested onnxruntime duplicates..."
HF_INNER="$NM/@huggingface/transformers/node_modules"
if [ -d "$HF_INNER" ]; then
    rm -rf "$HF_INNER/onnxruntime-node" 2>/dev/null || true
    rm -rf "$HF_INNER/onnxruntime-web" 2>/dev/null || true
    rm -rf "$HF_INNER/onnxruntime-common" 2>/dev/null || true
fi

# @huggingface/transformers: remove web-only dist files (Node only uses .node.mjs/.node.cjs)
HF_DIST="$NM/@huggingface/transformers/dist"
if [ -d "$HF_DIST" ]; then
    find "$HF_DIST" -type f \( -name "*.web.*" -o -name "*.min.*" \) -delete 2>/dev/null || true
fi

# Copy pre-downloaded embedding model to resources/
echo "[build-gateway] Copying embedding model..."
MODEL_SRC="$SCRIPT_DIR/../src-tauri/resources/models"
MODEL_DEST="$PROD_DIR/resources/models"
if [ -d "$MODEL_SRC" ]; then
    mkdir -p "$(dirname "$MODEL_DEST")"
    cp -r "$MODEL_SRC" "$MODEL_DEST"
    echo "[build-gateway] Embedding model copied."
fi

# Report size
TOTAL=$(du -sm "$PROD_DIR" | awk '{print $1}')
echo "[build-gateway] Production gateway size: ${TOTAL}MB"

# Package as tar.gz for Tauri bundling
echo "[build-gateway] Packaging gateway-bundle.tar.gz..."
TAR_OUTPUT="$SCRIPT_DIR/../src-tauri/gateway-bundle.tar.gz"
rm -f "$TAR_OUTPUT"
tar -czf "$TAR_OUTPUT" -C "$PROD_DIR" .
TAR_SIZE=$(du -sm "$TAR_OUTPUT" | awk '{print $1}')
echo "[build-gateway] Done! gateway-bundle.tar.gz: ${TAR_SIZE}MB"
