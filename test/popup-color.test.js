const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

/** Loads the pure color helpers from the popup's color module. */
function loadColorHelpers() {
  return require(path.join(__dirname, '..', 'firefox', 'popup', 'color.js'));
}

test('hexToHsv converts primary and neutral colors correctly', () => {
  const { hexToHsv } = loadColorHelpers();

  const red = hexToHsv('#FF0000');
  assert.equal(red.h, 0);
  assert.equal(red.s, 1);
  assert.equal(red.v, 1);

  const black = hexToHsv('#000000');
  assert.equal(black.s, 0);
  assert.equal(black.v, 0);

  const white = hexToHsv('#FFFFFF');
  assert.equal(white.s, 0);
  assert.equal(white.v, 1);

  const blue = hexToHsv('2962ff'); // lowercase, no '#', matches normalizeHexOrDefault handling
  assert.ok(Math.abs(blue.h - 224) < 1);
});

test('hsvToHex converts back to the expected uppercase hex string', () => {
  const { hsvToHex } = loadColorHelpers();

  assert.equal(hsvToHex(0, 1, 1), '#FF0000');
  assert.equal(hsvToHex(120, 1, 1), '#00FF00');
  assert.equal(hsvToHex(240, 1, 1), '#0000FF');
  assert.equal(hsvToHex(0, 0, 0), '#000000');
  assert.equal(hsvToHex(0, 0, 1), '#FFFFFF');
});

test('hexToHsv and hsvToHex round-trip for a sample of colors', () => {
  const { hexToHsv, hsvToHex } = loadColorHelpers();

  for (const hex of ['#2962FF', '#92CBF9', '#F4A460', '#F23645', '#089981', '#795548']) {
    const { h, s, v } = hexToHsv(hex);
    assert.equal(hsvToHex(h, s, v), hex);
  }
});

test('normalizeHexOrDefault accepts with/without "#" and falls back when invalid', () => {
  const { normalizeHexOrDefault } = loadColorHelpers();

  assert.equal(normalizeHexOrDefault('2962ff', '#000000'), '#2962FF');
  assert.equal(normalizeHexOrDefault('#2962FF', '#000000'), '#2962FF');
  assert.equal(normalizeHexOrDefault('not-a-color', '#ABCDEF'), '#ABCDEF');
  assert.equal(normalizeHexOrDefault('', '#ABCDEF'), '#ABCDEF');
});

test('clamp keeps values within bounds', () => {
  const { clamp } = loadColorHelpers();

  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});
