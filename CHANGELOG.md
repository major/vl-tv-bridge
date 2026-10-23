# Changelog

All notable changes to VL-TV Bridge.


## [2.0.3](https://github.com/major/vl-tv-bridge/compare/v2.0.2...v2.0.3) (2026-10-23)

### 🐛 Bug Fixes

* **drawings:** replace levels and trades on every draw ([#79](https://github.com/major/vl-tv-bridge/issues/79)) ([1e0a250](https://github.com/major/vl-tv-bridge/commit/1e0a250c2a7afa10fbb79e1a576641f7dd941152))

## [2.0.2](https://github.com/major/vl-tv-bridge/compare/v2.0.1...v2.0.2) (2026-10-23)

### 🐛 Bug Fixes

* **drawings:** retry snapped anchors on redraw ([#78](https://github.com/major/vl-tv-bridge/issues/78)) ([763db08](https://github.com/major/vl-tv-bridge/commit/763db0800b7e07c085487337e29660d6018fe9e5))

### 📚 Documentation

* **agents:** add real browser testing build notes 🦊 ([15886ac](https://github.com/major/vl-tv-bridge/commit/15886ac529a2c3546e6e4dcb97082645f2bbd52f))

## [2.0.1](https://github.com/major/vl-tv-bridge/compare/v2.0.0...v2.0.1) (2026-10-22)

### 🐛 Bug Fixes

* **alerts:** link created alerts to their drawn rays 🔗 ([3ab15ee](https://github.com/major/vl-tv-bridge/commit/3ab15ee605463a26887ef44bc059531524d55b2c))

## [2.0.0](https://github.com/major/vl-tv-bridge/compare/v1.9.0...v2.0.0) (2026-10-22)

* **deps:** lock file maintenance ([#64](https://github.com/major/vl-tv-bridge/issues/64)) ([0b8ad12](https://github.com/major/vl-tv-bridge/commit/0b8ad12d6e7f3744d132a13405ed61a64dcd60d5))
* **deps:** lock file maintenance ([#66](https://github.com/major/vl-tv-bridge/issues/66)) ([ae70e25](https://github.com/major/vl-tv-bridge/commit/ae70e25d53b303899993b132821b1647dca704ed))
* **deps:** update actions/setup-node digest to 949feb2 ([#65](https://github.com/major/vl-tv-bridge/issues/65)) ([db41151](https://github.com/major/vl-tv-bridge/commit/db411519c1dada43a4074dfa1b372852777b6dbd))
* **deps:** update dependency release-it to v21.1.1 ([#67](https://github.com/major/vl-tv-bridge/issues/67)) ([05acf9f](https://github.com/major/vl-tv-bridge/commit/05acf9f98f06d8bebb236343fbf36342e8f43785))

### ✨ Features

* **alerts:** sync TradingView alerts with drawn levels and trades 🔔 ([2dc6f53](https://github.com/major/vl-tv-bridge/commit/2dc6f53b45569e9cd83e7dfae4ade4ccf526077e))
* **background:** send fetch progress events to popup 📡 ([90564a0](https://github.com/major/vl-tv-bridge/commit/90564a0e6717c824d171661a5e6006395819abd5))
* **popup:** redesign popup for new users 🎨 ([e76cd81](https://github.com/major/vl-tv-bridge/commit/e76cd81c2f0548b33dde1dfd2ebea14ab039a945))
* **popup:** shrink setup status to one line 🚦 ([9f4b3bb](https://github.com/major/vl-tv-bridge/commit/9f4b3bb033f19846d6714df330b81f92cc625363))
* preserve valid level and trade drawings ([868dc70](https://github.com/major/vl-tv-bridge/commit/868dc70631544d660fff3c1eed558b7851fc8a7f))
* remove level clustering ([3cab0aa](https://github.com/major/vl-tv-bridge/commit/3cab0aac5581a8f2cc19dae0cb184b293dd74f77))
* update default trade line width and colors ([03d560d](https://github.com/major/vl-tv-bridge/commit/03d560d3fa19e5235c612e05ed5bcc1a9fedb29d)), references [#92CBF9](https://github.com/major/vl-tv-bridge/issues/92CBF9) [#F4A460](https://github.com/major/vl-tv-bridge/issues/F4A460)

### 🐛 Bug Fixes

* **popup:** replace color picker with hex code inputs 🎨 ([bfe8b97](https://github.com/major/vl-tv-bridge/commit/bfe8b97e9e19e761f553d204f677fa4a0e1bcffa))
* **popup:** use in-popup color picker instead of native dialog 🎨 ([2a426d8](https://github.com/major/vl-tv-bridge/commit/2a426d8a9b3abbb916c45dd14ebc8ff27ea7f61d))
* **popup:** widen hex color inputs to show the full code ([740add2](https://github.com/major/vl-tv-bridge/commit/740add22c719d45a78b1ecd07815d897288cafd6))

## [1.9.0](///compare/v1.8.8...v1.9.0) (2026-09-28)

### Features

* **levels:** anchor trade level rays to first-trade date 47e884a

### Bug Fixes

* match VolumeLeaders chart levels API fbd6ff0
* **popup:** avoid blocking on unverified VL cookie b035b95

## [1.8.8](///compare/v1.8.7...v1.8.8) (2026-07-01)

### Features

* **trades:** make label position configurable (left/right) f5d5063

## [1.8.7](///compare/v1.8.6...v1.8.7) (2026-06-23)

### Bug Fixes

* **trades:** add Array.isArray guard on response sub-array 090f593
* **trades:** use GetAllPriceVolumeTradeData for accurate dark pool flags 709dbae

## [1.8.6](///compare/v1.8.5...v1.8.6) (2026-06-23)

### Features

* add level line opacity setting 3ef33c3

## [1.8.5](///compare/v1.8.4...v1.8.5) (2026-06-17)

### Bug Fixes

* omit duplicate original trade rank f57ca2a

## [1.8.4](///compare/v1.8.3...v1.8.4) (2026-06-16)

### Features

* show original trade rank labels 264f25a

## [1.8.3](///compare/v1.8.2...v1.8.3) (2026-06-11)

### Bug Fixes

* parse VL trade times as market time 5cb880a

## [1.8.2](///compare/v1.8.1...v1.8.2) (2026-06-11)

### Bug Fixes

* hide invalid trade ranks 9cef429
* let workflow publish GitHub releases 2818d29

## [1.8.1](///compare/v1.8.0...v1.8.1) (2026-06-10)

### Bug Fixes

* let release workflow manage assets f0366c7
* use visible range for trade fetches 60546a9

## [1.8.0](///compare/v1.7.0...v1.8.0) (2026-06-09)

### Features

* add configurable trade rays 61b888c

## [1.7.0](///compare/v1.6.0...v1.7.0) (2026-01-25)

### Features

* **injected:** replace circles with text_note shapes 650329a, closes #1

## [1.6.0](///compare/v1.5.2...v1.6.0) (2026-01-25)

### Bug Fixes

* add XSRF token handling for ASP.NET anti-forgery f33c5a6

## [1.3.0](///compare/v1.2.1...v1.3.0) (2025-12-20)

### Features

* add configurable line color and thickness settings 82f2814, closes #02A9DE

## [1.2.1](///compare/v1.2.0...v1.2.1) (2025-12-15)

### Bug Fixes

* clear background script cache when clearing from popup 7354a03

## [1.2.0](///compare/v1.1.1...v1.2.0) (2025-12-08)

### Features

* add individual trade circles 6865eba

## [1.1.1](https://github.com/major/vl-tv-bridge/compare/v1.1.0...v1.1.1) (2025-12-08)

### ✨ Features

- Group nearby levels into zones for cleaner charts
- Allow user to pick level dates
- Pull 10 levels by default, allow user to pick 5

### 🐛 Bug Fixes

- Draw lines even if popup is closed

## [1.1.0](https://github.com/major/vl-tv-bridge/compare/v1.0.0...v1.1.0) (2025-12-07)

### 🔧 Setup

- Prepare for automated releases
- Fix release config
