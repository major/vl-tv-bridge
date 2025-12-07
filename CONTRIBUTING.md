# Contributing to VL TradingView Bridge

Thank you for your interest in contributing! This document provides technical information for developers who want to contribute to or modify the extension.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [How It Works](#how-it-works)
- [Building & Testing](#building--testing)
- [API Documentation](#api-documentation)
- [Debugging](#debugging)
- [Contributing Guidelines](#contributing-guidelines)

## Architecture Overview

The extension uses a multi-layer architecture to bridge the security boundary between the extension and the TradingView page:

```
┌─────────────────────────────────────────────────────────────┐
│                      Popup UI                               │
│              (popup/popup.html + popup.js)                 │
│  - User interface for control and status                    │
│  - Displays cached levels                                   │
└────────────────────┬────────────────────────────────────────┘
                     │ browser.runtime.sendMessage
                     ↓
┌─────────────────────────────────────────────────────────────┐
│                Background Script                            │
│                  (background.js)                            │
│  - Intercepts VolumeLeaders API calls                       │
│  - Manages storage and caching                              │
│  - Checks authentication                                    │
│  - Routes messages between popup and content script         │
└────────────────────┬────────────────────────────────────────┘
                     │ browser.tabs.sendMessage
                     ↓
┌─────────────────────────────────────────────────────────────┐
│                Content Script                               │
│        (content-script.js - runs on tradingview.com)        │
│  - Bridges extension context and page context               │
│  - Injects the drawing script                               │
│  - Uses window.postMessage for communication                │
└────────────────────┬────────────────────────────────────────┘
                     │ window.postMessage
                     ↓
┌─────────────────────────────────────────────────────────────┐
│                 Injected Script                             │
│              (injected.js - page context)                   │
│  - Direct access to TradingViewApi                          │
│  - Draws shapes using chart.createShape()                   │
│  - Manages shape IDs and cleanup                            │
└─────────────────────────────────────────────────────────────┘
```

### Why This Architecture?

- **Content Script Isolation**: Content scripts cannot access page JavaScript objects (like `TradingViewApi`)
- **Injected Script Access**: By injecting a script into the page context, we gain access to TradingView's API
- **Security Boundary**: window.postMessage bridges the content script and injected script securely
- **Background Persistence**: Background script maintains state and handles API interception

## Development Setup

### Prerequisites

- **Node.js** (v14+) and npm
- **Firefox** (v48+)
- **Git**
- **VolumeLeaders Account** (for testing)

### Initial Setup

```bash
# Clone the repository
git clone https://github.com/major/vl-tv-bridge.git
cd vl-tv-bridge

# Install dependencies
npm install

# Set up environment for signing (optional)
cp .env.example .env
# Edit .env with your Mozilla API credentials from:
# https://addons.mozilla.org/en-US/developers/addon/api/key/
```

### Running the Extension

```bash
# Option 1: Using npm (opens Firefox with extension loaded)
npm run start

# Option 2: Manual temporary installation
# 1. Open Firefox
# 2. Navigate to about:debugging#/runtime/this-firefox
# 3. Click "Load Temporary Add-on"
# 4. Select firefox/manifest.json
```

### Development Workflow

1. Make changes to files in `firefox/`
2. If using `npm run start`, click "Reload" in about:debugging
3. If manually loaded, click "Reload" next to the extension
4. Test changes on TradingView
5. Check browser console for errors (F12)

## Project Structure

```
vl-tv-bridge/
├── firefox/                          # Extension source code
│   ├── manifest.json                # Extension configuration (Manifest v2)
│   ├── background.js                # Background service worker (14 KB)
│   ├── content-script.js            # Content script for TradingView (6.3 KB)
│   ├── injected.js                  # Injected into page context (9.6 KB)
│   ├── popup/
│   │   ├── popup.html               # Extension popup UI
│   │   ├── popup.js                 # Popup logic and event handlers
│   │   └── popup.css                # Popup styling
│   └── icons/
│       ├── icon-48.png              # 48x48 toolbar icon
│       └── icon-96.png              # 96x96 display icon
│
├── build/                           # Build output (generated)
│   └── vl-tv-bridge-1.0.0.zip       # Built extension
│
├── node_modules/                    # npm dependencies (generated)
│
├── .github/
│   └── workflows/                   # GitHub Actions (CI/CD)
│
├── package.json                     # npm configuration and scripts
├── package-lock.json                # npm lock file
├── build.sh                         # Build automation script
├── .env.example                     # API credentials template
├── .gitignore                       # Git ignore rules
├── README.md                        # User documentation
├── CONTRIBUTING.md                  # This file
├── SIGNING.md                       # Mozilla signing instructions
└── TRADINGVIEW_API_NOTES.md        # TradingView API discovery notes
```

### Key Files Explained

#### `manifest.json`

Defines extension configuration:
- Permissions (webRequest, storage, cookies, etc.)
- Content script injection rules
- Background script
- Browser action (popup)
- Web accessible resources

#### `background.js`

Persistent background script that:
- Listens for VolumeLeaders API requests via `webRequest.onBeforeRequest`
- Extracts trade levels from POST request body
- Manages `browser.storage.local` for caching
- Checks VolumeLeaders authentication via cookies
- Routes messages between popup and content scripts

#### `content-script.js`

Runs on all TradingView pages and:
- Injects `injected.js` into page context
- Bridges messages between extension and page
- Detects current chart symbol from DOM
- Uses `window.postMessage` for page communication

#### `injected.js`

Injected into page context to:
- Access `TradingViewApi` global object
- Call `chart.createShape()` to draw horizontal lines
- Style lines with VolumeLeaders branding
- Track shape IDs for cleanup
- Post results back via `window.postMessage`

#### `popup/popup.js`

Controls extension popup:
- Displays authentication status
- Shows detected symbol
- Handles user actions (fetch, draw, clear, cache)
- Manages collapsible UI sections
- Sends messages to background script

## How It Works

### 1. API Interception

When you use the VolumeLeaders website normally, API calls are made to fetch trade levels. The extension intercepts these:

```javascript
// background.js
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method === 'POST' && details.requestBody) {
      const formData = parseFormData(details.requestBody.formData);
      const ticker = formData.Ticker;
      // Store intercepted data for later use
    }
  },
  { urls: ["*://www.volumeleaders.com/TradeLevels/GetTradeLevels"] },
  ["blocking", "requestBody"]
);
```

### 2. Storage Schema

Trade levels are stored in `browser.storage.local`:

```javascript
{
  "levels": {
    "AAPL": [
      {
        "price": 150.25,
        "dollars": 1629675136.36,
        "volume": 10803273,
        "trades": 60,
        "rank": 1,
        "dates": "2025-09-24 - 2025-11-25",
        "timestamp": "2025-12-07T10:30:00Z",
        "source": "api"
      },
      // ... more levels
    ],
    "TSLA": [...]
  }
}
```

### 3. Message Passing

The extension uses Firefox's messaging API:

```javascript
// Popup → Background
browser.runtime.sendMessage({
  command: 'FETCH_VL_LEVELS',
  ticker: 'AAPL'
});

// Background → Content Script
browser.tabs.sendMessage(tabId, {
  command: 'DRAW_LEVELS',
  levels: [...],
  ticker: 'AAPL'
});

// Content Script ↔ Injected Script (via window.postMessage)
window.postMessage({
  source: 'vl-tv-content',
  command: 'DRAW_LEVELS',
  data: { levels: [...], ticker: 'AAPL' }
}, '*');
```

### 4. Drawing on Charts

The injected script uses TradingView's undocumented API:

```javascript
// injected.js
const chart = TradingViewApi.activeChart();

const shapeId = await chart.createShape(
  { price: 150.25 },  // Price anchor point
  {
    shape: 'horizontal_line',
    text: 'VL #1 $1.6B',
    overrides: {
      linecolor: '#02A9DE',      // VL cyan color
      linewidth: 2,
      linestyle: 0,              // 0=solid, 1=dotted, 2=dashed
      showLabel: true,
      textcolor: '#02A9DE',
      fontsize: 12,
      bold: true,
      horzLabelsAlign: 'right',
      vertLabelsAlign: 'middle'
    }
  }
);

// Store shapeId for later removal
window.vlTvShapeIds = window.vlTvShapeIds || [];
window.vlTvShapeIds.push(shapeId);
```

### 5. Symbol Detection

Multiple methods are used to detect the current chart symbol (in order of priority):

1. **Chart API**: `TradingViewApi.activeChart().symbol()`
2. **URL Parsing**: Extract from `/chart/AAPL` or `/symbols/NASDAQ:AAPL`
3. **Page Title**: Parse `document.title` (e.g., "AAPL Chart")
4. **DOM Elements**: Find symbol in chart title elements

## Building & Testing

### NPM Scripts

```bash
# Development
npm run start              # Run extension in Firefox (dev mode)
npm run lint               # Lint extension code

# Building
npm run build              # Build unsigned ZIP/XPI
npm run rename-artifacts   # Rename build files to vl-tv-bridge

# Signing (requires .env configuration)
npm run sign               # Sign with Mozilla (creates XPI)
npm run build:signed       # Build and sign in one command
```

### Build Script

The `build.sh` script provides more control:

```bash
./build.sh           # Build Firefox extension
./build.sh -f        # Build Firefox only
./build.sh -s        # Build and sign with Mozilla
./build.sh -c        # Clean build directory
./build.sh -h        # Show help

# Common workflows
./build.sh -c && ./build.sh -s    # Clean, build, and sign
```

### Testing Checklist

Before submitting changes, test:

- [ ] Extension loads without errors
- [ ] VolumeLeaders authentication detection works
- [ ] Symbol detection works on various TradingView pages
- [ ] Levels fetch correctly from API
- [ ] Levels draw on chart with correct styling
- [ ] Cache stores and retrieves levels
- [ ] Clear drawn levels removes all lines
- [ ] Manual level entry works
- [ ] Debug mode logs properly
- [ ] UI is responsive and clear
- [ ] No console errors in production mode

### Manual Testing Workflow

1. Load extension in Firefox (`npm run start`)
2. Log into volumeleaders.com
3. Open TradingView chart (e.g., tradingview.com/chart/AAPL)
4. Click extension icon
5. Verify detected symbol is correct
6. Click "Fetch & Draw VL Levels"
7. Confirm lines appear on chart
8. Test clear, cache, and manual entry features
9. Check browser console for errors

## API Documentation

### VolumeLeaders API

**Endpoint:**
```
POST https://www.volumeleaders.com/TradeLevels/GetTradeLevels
Content-Type: application/x-www-form-urlencoded
```

**Parameters:**
```javascript
{
  Ticker: 'AAPL',
  MinDate: '2020-12-07',        // 5 years ago
  MaxDate: '2025-12-07',         // Today
  MinDollars: 10000000,          // $10M minimum
  MaxDollars: 999999999999,
  MinPrice: 0,
  MaxPrice: 999999,
  TradeLevelRank: '1,2,3,4,5',  // Top 5 levels
  // DataTables pagination parameters
  draw: 1,
  start: 0,
  length: 50,
  // ... many more parameters
}
```

**Response:**
```javascript
{
  "data": [
    {
      "Ticker": "AAPL",
      "Price": 150.25,
      "Dollars": 1629675136.36,
      "Volume": 10803273,
      "Trades": 60,
      "TradeLevelRank": 1,
      "Dates": "2025-09-24 - 2025-11-25",
      // ... more fields
    }
  ],
  "draw": 1,
  "recordsTotal": 5,
  "recordsFiltered": 5
}
```

**Authentication:**
- Cookie-based: `.ASPXAUTH` cookie from volumeleaders.com
- Extension checks via `browser.cookies.getAll()`

### TradingView Chart API (Undocumented)

The TradingView API is not officially documented. See `TRADINGVIEW_API_NOTES.md` for discovery process.

**Key Methods:**

```javascript
// Get active chart
const chart = TradingViewApi.activeChart();

// Get current symbol
const symbol = chart.symbol();  // Returns: "NASDAQ:AAPL"

// Create horizontal line
const shapeId = await chart.createShape(
  { price: 150.25 },
  {
    shape: 'horizontal_line',
    text: 'Label Text',
    overrides: {
      linecolor: '#02A9DE',
      linewidth: 2,
      linestyle: 0,  // 0=solid, 1=dotted, 2=dashed
      showLabel: true,
      textcolor: '#02A9DE',
      fontsize: 12,
      bold: true,
      horzLabelsAlign: 'right',  // 'left', 'center', 'right'
      vertLabelsAlign: 'middle'   // 'top', 'middle', 'bottom'
    }
  }
);

// Remove a shape
chart.removeEntity(shapeId);

// Get all shapes
const shapes = chart.getAllShapes();  // Returns: array of shape objects

// Get specific shape
const shape = chart.getShapeById(shapeId);
```

**Important Notes:**
- API is undocumented and may change without notice
- All methods return Promises (use `await`)
- Shape IDs must be stored for later modification/removal
- API only accessible in page context (requires script injection)

### Extension Messaging API

**Commands (Popup → Background):**

```javascript
// Get stored levels for a ticker
{ command: 'GET_LEVELS', ticker: 'AAPL' }
// Response: { levels: [...] }

// Fetch levels from VolumeLeaders API
{ command: 'FETCH_VL_LEVELS', ticker: 'AAPL' }
// Response: { success: true, levels: [...] } or { success: false, error: '...' }

// Clear all cached levels
{ command: 'CLEAR_CACHE' }
// Response: { success: true }

// Get all cached levels
{ command: 'GET_ALL_LEVELS' }
// Response: { levels: { AAPL: [...], TSLA: [...] } }

// Check VolumeLeaders authentication
{ command: 'CHECK_VL_AUTH' }
// Response: { authenticated: true/false }
```

**Commands (Background → Content Script → Injected):**

```javascript
// Draw levels on chart
{ command: 'DRAW_LEVELS', levels: [...], ticker: 'AAPL' }
// Response: { success: true, drawnCount: 5, shapeIds: [...] }

// Clear drawn levels
{ command: 'CLEAR_DRAWN' }
// Response: { success: true, removedCount: 5 }

// Get current chart symbol
{ command: 'GET_SYMBOL' }
// Response: { symbol: 'AAPL' } or { symbol: null, error: '...' }
```

## Debugging

### Enable Debug Mode

1. Click extension icon
2. Check "Enable Debug Mode"
3. Open browser console (F12 → Console)

### Debug Logs

All extension logs are prefixed with `[VL-TV]`:

```javascript
// In any extension script
console.log('[VL-TV Background]', 'Message here');
console.error('[VL-TV Content]', 'Error message');
console.debug('[VL-TV Injected]', 'Debug info');
```

### Common Issues

**"TradingViewApi is not defined"**
- The injected script hasn't loaded yet
- TradingView updated and changed their API
- You're not on a chart page

**"Cannot read property 'createShape' of undefined"**
- No active chart found
- Try clicking on the chart to activate it
- Refresh the page

**"Could not detect symbol"**
- Symbol detection failed
- Check console for which methods were tried
- Manually verify chart is displaying a symbol

**Levels not drawing**
- Check that levels array is not empty
- Verify price values are valid numbers
- Look for shape creation errors in console
- Ensure you're authenticated with TradingView

### Inspecting Storage

```javascript
// In browser console (F12)
browser.storage.local.get('levels').then(console.log);

// Clear all storage
browser.storage.local.clear();
```

### Network Debugging

1. Open DevTools (F12)
2. Go to Network tab
3. Filter for "GetTradeLevels"
4. Refresh VolumeLeaders page or click extension button
5. Inspect POST request and response

## Contributing Guidelines

### Code Style

- Use consistent indentation (2 spaces)
- Add comments for complex logic
- Use descriptive variable names
- Prefix console logs with `[VL-TV ScriptName]`
- Keep functions focused and single-purpose

### Commit Messages

Use conventional commit format:

```
feat: add support for crypto symbols
fix: symbol detection on mobile view
docs: update API documentation
refactor: simplify level storage logic
style: format popup.css
test: add symbol detection tests
```

### Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Test thoroughly (see Testing Checklist)
5. Commit with clear messages
6. Push to your fork
7. Open a Pull Request with:
   - Clear description of changes
   - Screenshots/videos if UI changes
   - Testing steps performed
   - Any breaking changes noted

### What to Contribute

Ideas for contributions:

- **Features**
  - Support for additional brokers/data sources
  - Customizable line colors and styles
  - Level alerts and notifications
  - Export levels to CSV

- **Bug Fixes**
  - Symbol detection improvements
  - API compatibility updates
  - UI/UX improvements

- **Documentation**
  - Code examples
  - Video tutorials
  - API reverse engineering notes

- **Testing**
  - Automated tests
  - Cross-browser compatibility
  - Performance optimization

### Reporting Issues

When reporting bugs, please include:

1. Firefox version
2. Extension version
3. Steps to reproduce
4. Expected behavior
5. Actual behavior
6. Console errors (with debug mode enabled)
7. Screenshots if applicable

## Security

### Reporting Vulnerabilities

If you discover a security vulnerability, please email directly instead of opening a public issue.

### Security Considerations

- Never commit API credentials or `.env` file
- Validate all user input before processing
- Sanitize data before injecting into page
- Use `browser.runtime.getURL()` for resource loading
- Review permissions carefully before adding new ones

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Questions?

- Open an issue for questions
- Check existing issues and documentation first
- Be respectful and constructive

Thank you for contributing to VL TradingView Bridge!
