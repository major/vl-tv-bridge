# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Firefox WebExtension that bridges VolumeLeaders and TradingView. It intercepts VL API calls to extract institutional trade levels and draws them as horizontal lines on TradingView charts using TradingView's undocumented `createShape()` API.

## Development Commands

```bash
npm run start         # Run in Firefox with hot-reload (via web-ext)
npm run lint          # Lint extension with web-ext
npm run build         # Build unsigned ZIP/XPI
npm run build:signed  # Build and sign with Mozilla
```

## Releases

Use `release-it` for all releases - never create version commits or tags manually.

```bash
npm run release        # patch release
npm run release:minor  # minor release
npm run release:major  # major release
npm run release:dry    # dry run to preview
```

This handles: lint, version bumps (package.json + manifest.json), changelog, commit, tag, build, and GitHub release with assets.

## Architecture

Multi-layer context-bridging design to work around Firefox's WebExtension security boundaries:

```
Popup UI (popup/)
    ↓ browser.runtime.sendMessage
Background Script (background.js)
    - Intercepts VolumeLeaders API via webRequest
    - Manages browser.storage.local caching
    - Checks VL authentication via cookies
    ↓ browser.tabs.sendMessage
Content Script (content-script.js)
    - Injected on tradingview.com
    - Bridges extension ↔ page communication
    - Detects current chart symbol
    ↓ window.postMessage
Injected Script (injected.js)
    - Runs in page context (not extension context)
    - Direct access to TradingViewApi global
    - Draws horizontal lines via chart.createShape()
```

**Why this layering?** Content scripts cannot access page JavaScript objects. The injected script runs in page context to access TradingView's API, communicating back via `window.postMessage`.

## Key Files

- `firefox/manifest.json` - Manifest v2, defines permissions and scripts
- `firefox/background.js` - API interception, caching, message routing
- `firefox/content-script.js` - TradingView integration, script injection
- `firefox/injected.js` - Shape drawing using TradingView's internal API
- `firefox/ticker-map.js` - Symbol normalization utilities
- `firefox/popup/` - Extension popup UI (settings, actions)

## Storage Schema

Trade levels cached in `browser.storage.local` under `levels` key, keyed by ticker symbol. Each level contains: price, dollars, volume, trades, rank, dates, timestamp, source.
