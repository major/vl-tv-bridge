# AGENTS.md

Firefox WebExtension bridging VolumeLeaders trade levels into TradingView chart lines.

## Commands

- `npm test` - run tests
- `npm run lint` - web-ext lint
- `npm run build` - unsigned ZIP/XPI
- `npm run start` - run in Firefox with hot reload

## Releases

Use `release-it`; never create version commits or tags manually.

- Patch: `npm run release -- patch --ci`
- Minor: `npm run release:minor -- --ci`
- Major: `npm run release:major -- --ci`
- Dry run: `npm run release:dry -- patch --ci`

Release-it bumps `package.json`, `package-lock.json`, and `firefox/manifest.json`, updates `CHANGELOG.md`, commits, tags, and pushes.

A pushed `v*` tag triggers `.github/workflows/release.yml` to build/sign assets and create the GitHub release. Do not wait on that workflow unless the user asks; report the Actions URL.

## Progressive discovery

Start with these files depending on task:

- Extension metadata/permissions: `firefox/manifest.json`
- API interception/cache/auth: `firefox/background.js`
- TradingView page bridge: `firefox/content-script.js`
- TradingView shape drawing: `firefox/injected.js`
- Ticker normalization: `firefox/ticker-map.js`
- Popup UI: `firefox/popup/`

Important boundary: content scripts cannot access page JS objects, so TradingView API calls must happen from `injected.js` via `window.postMessage`.
