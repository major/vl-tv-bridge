#!/bin/bash
set -euo pipefail

# 🎯 VL TradingView Bridge - Build Script

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$PROJECT_ROOT/build"
FIREFOX_SRC="$PROJECT_ROOT/firefox"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1" >&2; }

build_firefox() {
    log "Building Firefox extension..."

    # Check if web-ext is available (via npm)
    if command -v npx &>/dev/null && [ -f "$PROJECT_ROOT/package.json" ]; then
        log "Using web-ext to build..."
        npx web-ext build --source-dir="$FIREFOX_SRC" --artifacts-dir="$BUILD_DIR" --overwrite-dest
        log "Firefox build complete!"
        return
    fi

    # Fallback to manual build
    warn "web-ext not found, using manual build..."

    local out_dir="$BUILD_DIR/firefox"
    rm -rf "$out_dir"
    mkdir -p "$out_dir"

    # Copy extension files
    cp "$FIREFOX_SRC/manifest.json" "$out_dir/"
    cp "$FIREFOX_SRC/ticker-map.js" "$out_dir/"
    cp "$FIREFOX_SRC/background.js" "$out_dir/"
    cp "$FIREFOX_SRC/content-script.js" "$out_dir/"
    cp "$FIREFOX_SRC/injected.js" "$out_dir/"

    # Copy popup
    mkdir -p "$out_dir/popup"
    cp "$FIREFOX_SRC/popup/"* "$out_dir/popup/"

    # Copy icons
    mkdir -p "$out_dir/icons"
    cp "$FIREFOX_SRC/icons/"*.png "$out_dir/icons/" 2>/dev/null || {
        warn "No PNG icons found - converting from SVG..."
        if command -v magick &>/dev/null; then
            magick "$FIREFOX_SRC/icons/icon-48.svg" "$out_dir/icons/icon-48.png"
            magick "$FIREFOX_SRC/icons/icon-48.svg" -resize 96x96 "$out_dir/icons/icon-96.png"
        else
            error "ImageMagick not installed - please create PNG icons manually"
        fi
    }

    # Create XPI (Firefox extension package)
    local version
    version=$(jq -r '.version' "$out_dir/manifest.json")
    local xpi_name="vl-tv-bridge-${version}.xpi"

    cd "$out_dir"
    zip -r -q "../$xpi_name" ./*
    cd "$PROJECT_ROOT"

    log "Created: build/$xpi_name"
    log "Firefox build complete!"
}

clean() {
    log "Cleaning build directory..."
    rm -rf "$BUILD_DIR"
    log "Clean complete!"
}

sign_firefox() {
    log "Signing Firefox extension with Mozilla..."

    # Load .env if it exists
    if [ -f "$PROJECT_ROOT/.env" ]; then
        log "Loading credentials from .env..."
        set -a
        source "$PROJECT_ROOT/.env"
        set +a
    fi

    # Check for required credentials
    if [ -z "$WEB_EXT_API_KEY" ] || [ -z "$WEB_EXT_API_SECRET" ]; then
        error "Missing API credentials!"
        error "Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET environment variables"
        error "or create a .env file. See SIGNING.md for details."
        exit 1
    fi

    # Use npm if available
    if command -v npm &>/dev/null && [ -f "$PROJECT_ROOT/package.json" ]; then
        log "Using npm to sign..."
        npm run sign
    else
        error "npm not found - signing requires web-ext via npm"
        exit 1
    fi

    log "Signing complete!"
}

usage() {
    cat << EOF
Usage: $0 [options]

Options:
    -f, --firefox     Build Firefox extension only
    -s, --sign        Build and sign with Mozilla (requires API credentials)
    -c, --clean       Clean build directory
    -h, --help        Show this help

Examples:
    $0                Build everything
    $0 -f             Build Firefox only
    $0 -s             Build and sign with Mozilla
    $0 -c             Clean build directory

Note: For signing, set WEB_EXT_API_KEY and WEB_EXT_API_SECRET environment variables
      or create a .env file. See SIGNING.md for details.
EOF
}

# Parse arguments
BUILD_FIREFOX=false
DO_CLEAN=false
DO_SIGN=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -f|--firefox)
            BUILD_FIREFOX=true
            shift
            ;;
        -s|--sign)
            BUILD_FIREFOX=true
            DO_SIGN=true
            shift
            ;;
        -c|--clean)
            DO_CLEAN=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            error "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

# Default: build everything
if ! $BUILD_FIREFOX && ! $DO_CLEAN; then
    BUILD_FIREFOX=true
fi

# Execute
mkdir -p "$BUILD_DIR"

if $DO_CLEAN; then
    clean
fi

if $BUILD_FIREFOX; then
    build_firefox
fi

if $DO_SIGN; then
    sign_firefox
fi

echo ""
log "🎉 Build complete!"
