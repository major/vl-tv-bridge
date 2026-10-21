/**
 * VL TradingView Bridge - Color helpers
 * Pure hex/HSV functions shared by the popup color picker and its tests.
 */

/**
 * Normalizes a color string to uppercase #RRGGBB, falling back to a default
 * when the input is missing or malformed.
 */
function normalizeHexOrDefault(value, fallback) {
  let color = (value || '').trim().toUpperCase();
  if (color && !color.startsWith('#')) {
    color = '#' + color;
  }
  return /^#[0-9A-F]{6}$/.test(color) ? color : fallback;
}

/** Clamps `value` between `min` and `max`. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Converts a 0-255 channel value to a 2-digit uppercase hex string, e.g. 255 -> "FF". */
function channelToHex(value) {
  return Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0').toUpperCase();
}

/**
 * Converts HSV color values to an uppercase "#RRGGBB" hex string.
 * `h` is hue in degrees (0-360), `s` and `v` are saturation/value in the 0-1 range.
 */
function hsvToHex(h, s, v) {
  const hue = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) { r = c; g = x; b = 0; }
  else if (hue < 120) { r = x; g = c; b = 0; }
  else if (hue < 180) { r = 0; g = c; b = x; }
  else if (hue < 240) { r = 0; g = x; b = c; }
  else if (hue < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return `#${channelToHex((r + m) * 255)}${channelToHex((g + m) * 255)}${channelToHex((b + m) * 255)}`;
}

/**
 * Converts a "#RRGGBB" hex string (any case) to HSV: hue in degrees (0-360),
 * saturation/value in the 0-1 range. Malformed input falls back to black.
 */
function hexToHsv(hex) {
  const normalized = normalizeHexOrDefault(hex, '#000000');
  const r = parseInt(normalized.slice(1, 3), 16) / 255;
  const g = parseInt(normalized.slice(3, 5), 16) / 255;
  const b = parseInt(normalized.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  if (h < 0) h += 360;

  const s = max === 0 ? 0 : delta / max;
  const v = max;
  return { h, s, v };
}

// Export for Node tests; in the popup these are plain globals
if (typeof module !== 'undefined') {
  module.exports = { normalizeHexOrDefault, clamp, channelToHex, hsvToHex, hexToHsv };
}
