# VL TradingView Bridge

A Firefox extension that automatically draws [VolumeLeaders](https://www.volumeleaders.com/) trade levels on your [TradingView](https://www.tradingview.com/) charts.

## What Does It Do?

This extension bridges VolumeLeaders and TradingView, allowing you to:

- **Automatically fetch** top trade levels from VolumeLeaders for any stock
- **Visualize levels** as horizontal lines directly on TradingView charts
- **Cache levels** for offline viewing and quick access
- **One-click workflow** - just click "Fetch & Draw VL Levels"

No more manually copying price levels between platforms!

## Features

- **Automatic Symbol Detection** - Detects which stock you're viewing on TradingView
- **One-Click Drawing** - Fetches and draws all levels with a single click
- **Smart Caching** - Stores previously fetched levels for offline access
- **Color-Coded Labels** - Each level shows rank, dollar volume, and date range
- **Manual Entry** - Add custom levels for analysis
- **Easy Cleanup** - Clear all drawn levels with one click
- **Debug Mode** - Troubleshoot issues with detailed logging

## Requirements

- **Firefox** (version 48.0 or later)
- **VolumeLeaders Account** - You must be logged into volumeleaders.com
- **TradingView Account** - Free or paid account works

## Installation

### Option 1: Install from Firefox Add-ons (Recommended)

*Coming soon - extension is currently in unlisted mode*

### Option 2: Install Signed XPI

1. Download the latest signed `.xpi` file from the [Releases](https://github.com/major/vl-tv-bridge/releases) page
2. Open Firefox
3. Drag the `.xpi` file into Firefox window
4. Click "Add" when prompted to install

### Option 3: Temporary Installation (Development)

1. Download or clone this repository
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Navigate to the `firefox/` folder and select `manifest.json`

**Note:** Temporary installations are removed when Firefox closes.

## Usage

### First Time Setup

1. **Authenticate with VolumeLeaders**
   - Open a new tab and log into [volumeleaders.com](https://www.volumeleaders.com/)
   - Keep the browser session active (don't log out)

2. **Open TradingView**
   - Navigate to [tradingview.com](https://www.tradingview.com/)
   - Open any chart (e.g., AAPL, TSLA, SPY)

### Fetching and Drawing Levels

1. **Click the Extension Icon**
   - The VL-TV Bridge icon appears in your Firefox toolbar
   - The popup shows authentication status and current symbol

2. **Verify the Detected Symbol**
   - The extension automatically detects the chart symbol
   - Confirm it shows the correct ticker (e.g., "AAPL")

3. **Click "Fetch & Draw VL Levels"**
   - The extension fetches the top 5 trade levels from VolumeLeaders
   - Horizontal lines appear on your chart automatically
   - Each line shows:
     - VL rank (#1, #2, etc.)
     - Dollar volume (e.g., $1.6B)
     - Date range when the level was active

4. **View Cached Levels**
   - Previously fetched levels are stored locally
   - Click "Show/Hide Cached Levels" to view all cached symbols
   - Click any cached symbol to draw its levels

### Managing Levels

**Clear Drawn Levels**
- Click "Clear Drawn Levels" to remove all VL lines from the chart
- This doesn't delete cached data, just clears the visualization

**Add Manual Level**
- Enter a price in the "Manual Price" field
- Click "Add Manual Level" to draw a custom line
- Useful for adding your own support/resistance levels

**Clear Cache**
- Click "Clear Cache" to delete all stored levels
- This removes all cached data (cannot be undone)

**Debug Mode**
- Enable debug mode for detailed console logging
- Useful for troubleshooting issues

## Understanding the Levels

Each VL trade level represents a price where significant institutional trading occurred:

- **VL #1** - Highest dollar volume trade level (most significant)
- **VL #2-5** - Decreasing significance
- **Dollar Volume** - Total money transacted at that level
- **Date Range** - When the level was active (up to 5 years of history)

The extension fetches levels with:
- Minimum $10M dollar volume
- Top 5 ranked levels
- Up to 5 years of historical data

## Troubleshooting

### "Not authenticated with VolumeLeaders"

**Solution:**
1. Open a new tab and go to [volumeleaders.com](https://www.volumeleaders.com/)
2. Log in with your credentials
3. Return to TradingView and try again

### "Could not detect symbol"

**Solution:**
1. Make sure you're on a TradingView chart page (not homepage)
2. Try refreshing the page
3. Click directly on the chart to ensure it's active

### Levels not drawing on chart

**Solution:**
1. Enable debug mode in the extension popup
2. Open browser console (F12 → Console tab)
3. Look for error messages starting with `[VL-TV]`
4. Try refreshing the TradingView page
5. Ensure you're on the main chart view (not symbol overview)

### "Failed to fetch levels"

**Solution:**
1. Check your VolumeLeaders authentication (see above)
2. Verify the symbol exists on VolumeLeaders
3. Check your internet connection
4. Look at debug console for specific error messages

### Cached levels showing wrong symbol

**Solution:**
1. Clear the cache using "Clear Cache" button
2. Re-fetch levels for the correct symbol

## Privacy & Permissions

This extension requires the following permissions:

- **webRequest & webRequestBlocking** - To intercept VolumeLeaders API calls and extract trade levels
- **storage** - To cache trade levels locally in your browser
- **cookies** - To verify you're logged into VolumeLeaders
- **Access to all websites** - To work on TradingView and VolumeLeaders domains

**Your data:**
- Trade levels are cached locally in your browser only
- No data is sent to external servers (except the original VolumeLeaders API)
- Your VolumeLeaders credentials are never accessed or stored by this extension

## Support

- **Issues** - Report bugs at [GitHub Issues](https://github.com/major/vl-tv-bridge/issues)
- **Documentation** - See [CONTRIBUTING.md](CONTRIBUTING.md) for technical details

## License

MIT License - See [LICENSE](LICENSE) file for details

## Credits

Created by [major](https://github.com/major)

This extension is not affiliated with or endorsed by VolumeLeaders or TradingView.
