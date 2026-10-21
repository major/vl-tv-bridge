/**
 * VL TradingView Bridge - Color helpers
 * Pure hex helpers shared by the popup color inputs and its tests.
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

// Export for Node tests; in the popup this is a plain global
if (typeof module !== 'undefined') {
  module.exports = { normalizeHexOrDefault };
}
