const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

/** Loads the pure color helpers from the popup's color module. */
function loadColorHelpers() {
  return require(path.join(__dirname, '..', 'firefox', 'popup', 'color.js'));
}

const FALLBACK = '#ABCDEF';

const NORMALIZE_CASES = [
  { name: 'accepts uppercase hex', input: '#2962FF', expected: '#2962FF' },
  { name: 'turns lowercase hex into uppercase', input: '#2962ff', expected: '#2962FF' },
  { name: 'adds a missing leading #', input: '2962ff', expected: '#2962FF' },
  { name: 'trims surrounding whitespace', input: '  #2962FF \n', expected: '#2962FF' },
  { name: 'rejects a code that is too short', input: '#2962F', expected: FALLBACK },
  { name: 'rejects a code that is too long', input: '#2962FFF', expected: FALLBACK },
  { name: 'rejects non-hex characters', input: '#GGGGGG', expected: FALLBACK },
  { name: 'falls back for an empty string', input: '', expected: FALLBACK },
  { name: 'falls back for only whitespace', input: '   ', expected: FALLBACK },
  { name: 'falls back for null', input: null, expected: FALLBACK }
];

for (const { name, input, expected } of NORMALIZE_CASES) {
  test(`normalizeHexOrDefault ${name}`, () => {
    // Arrange
    const { normalizeHexOrDefault } = loadColorHelpers();

    // Act
    const result = normalizeHexOrDefault(input, FALLBACK);

    // Assert
    assert.equal(result, expected);
  });
}
