import test from 'node:test';
import assert from 'node:assert/strict';
import { parseErrorLocation } from '../src/core/parse-error.js';

const genericMessage = 'Unexpected token: input is not valid JSON';

for (const [text, position] of [
  ['', 0], [' \n', 2], ['{"a":1,"b":}', 11], ['{"a":tru}', 8],
  ['{"a":true x}', 10], ['{"a" 1}', 5], ['{"a":1,}', 7],
  ['[1,]', 3], ['[1 2]', 3], ['[', 1], ['{"a":[]', 7],
  ['"unterminated', 13], ['"bad\nline"', 4], ['"\\x"', 2],
  ['"\\u12x4"', 5], ['"\\u12', 5], ['[01]', 2], ['[-]', 2],
  ['[1.]', 3], ['[1e+]', 4], ['[nul]', 4], ['true false', 5],
  ['{\n "a":false,\n "b":}', 19],
]) {
  test(`fallback locates invalid input ${JSON.stringify(text)}`, () => {
    assert.throws(() => JSON.parse(text), SyntaxError);
    const before = text.slice(0, position);
    const lines = before.split('\n');
    assert.deepEqual(parseErrorLocation(genericMessage, text), {
      position, line: lines.length, column: lines.at(-1).length + 1,
    });
  });
}

test('fallback accepts valid tokens and deep containers without inventing a location', () => {
  const valid = [
    '{"a":[true,false,null,-0,1.2e-3,1E+8],"b":"\\u0000\\n\\t\\r\\b\\f\\\\\\/\\\""}',
    '"😀\u2028"', '0', '[]', '{}', '\n null\t',
    '['.repeat(20000) + '0' + ']'.repeat(20000),
  ];
  for (const text of valid) {
    JSON.parse(text);
    assert.deepEqual(parseErrorLocation(genericMessage, text), { position: null, line: null, column: null });
  }
  const invalid = '['.repeat(20000) + 'tru' + ']'.repeat(20000);
  assert.equal(parseErrorLocation(genericMessage, invalid).position, 20003);
});

test('native offsets take precedence and native line/column remain usable without source', () => {
  assert.deepEqual(parseErrorLocation('Unexpected token at position 4', '{\n  x}'), {
    position: 4, line: 2, column: 3,
  });
  assert.deepEqual(parseErrorLocation('Bad JSON (line 3 column 4)'), {
    position: null, line: 3, column: 4,
  });
});
