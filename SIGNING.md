# Firefox Extension Signing Guide

This extension is signed using Mozilla's Add-on API to create unlisted, signed XPI files that can be installed in Firefox without warnings.

## Getting API Credentials

1. **Create a Firefox Account** (if you don't have one)
   - Go to [addons.mozilla.org](https://addons.mozilla.org)
   - Sign up or log in

2. **Generate API Credentials**
   - Visit [https://addons.mozilla.org/en-US/developers/addon/api/key/](https://addons.mozilla.org/en-US/developers/addon/api/key/)
   - Click "Generate new credentials"
   - Copy your `JWT issuer` (this is your API key)
   - Copy your `JWT secret` (this is your API secret)
   - **Important**: Save these securely - you won't be able to see the secret again!

## Local Signing

### Setup

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and add your credentials:
   ```bash
   WEB_EXT_API_KEY=user:12345678:123
   WEB_EXT_API_SECRET=your-secret-here
   ```

3. **Never commit `.env`** - it's in `.gitignore` for your protection

### Building and Signing

```bash
# Install dependencies (first time)
npm install

# Build and sign in one command
npm run build:signed

# Or run separately
npm run build    # Build unsigned extension
npm run sign     # Sign the extension
```

The signed XPI will be created in the `build/` directory with a name like `vl_tradingview_bridge-1.0.0.xpi`.

## GitHub Actions Signing

### Setup Secrets

1. Go to your GitHub repository
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Add two secrets:
   - Name: `WEB_EXT_API_KEY`
     Value: Your JWT issuer (e.g., `user:12345678:123`)
   - Name: `WEB_EXT_API_SECRET`
     Value: Your JWT secret

### Creating a Release

Once the secrets are configured, creating a release is automatic:

```bash
# Update version in firefox/manifest.json first
# Then create and push a tag
git tag v1.0.0
git push origin v1.0.0
```

The GitHub Actions workflow will:
1. Build the extension
2. Sign it with Mozilla
3. Create a GitHub release
4. Upload the signed XPI and source ZIP

## Unlisted Extensions

This extension is configured to be **unlisted** (`--channel=unlisted`), which means:
- ✅ Signed by Mozilla (no installation warnings)
- ✅ Not published on addons.mozilla.org
- ✅ Distributed directly via GitHub releases
- ✅ Automatic updates can still work if configured

## Troubleshooting

### "Could not sign add-on" error

- **Check credentials**: Make sure `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` are correct
- **Version conflict**: If the version already exists, increment the version in `manifest.json`
- **Rate limits**: Mozilla has rate limits - wait a few minutes and try again

### "Invalid add-on ID" error

- Make sure your `manifest.json` has a valid `browser_specific_settings.gecko.id` field
- The ID should be in email format or UUID format

### Local signing not working

```bash
# Check environment variables are loaded
source .env
echo $WEB_EXT_API_KEY  # Should show your key

# Run with explicit env vars
WEB_EXT_API_KEY=your-key WEB_EXT_API_SECRET=your-secret npm run sign
```

## References

- [web-ext documentation](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)
- [Mozilla Add-on API Keys](https://addons.mozilla.org/en-US/developers/addon/api/key/)
- [Signing and Distribution Overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
