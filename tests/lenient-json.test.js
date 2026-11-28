import test from 'node:test';
import assert from 'node:assert/strict';
import { convertLenientJson } from '../src/core/lenient-json.js';
import { formatJson } from '../src/core/json.js';

const CONVERSION_CASES = [
  ['line comment', '// comment\n{"a": 1} // tail', '{"a":1}'],
  ['line comment with CR/U+2028/U+2029', '// c1\r// c2\u2028// c3\u2029[1,2]', '[1,2]'],
  ['block comment', '/* head */ {"a": /* mid */ 1} /* tail */', '{"a":1}'],
  ['trailing commas in object and array', '{a: 1, b: [1, 2, ], }', '{"a":1,"b":[1,2]}'],
  ['unquoted identifier keys', '{$a_1: 1, _b2: 2, 中文: 3, true: 4, null: 5}', '{"$a_1":1,"_b2":2,"中文":3,"true":4,"null":5}'],
  ['unicode escaped identifier keys', '{\\u0061\\u0062: 1, a\\u005f1: 2}', '{"ab":1,"a_1":2}'],
  ['single-quoted keys and strings', "{'a\\'b': 'c\"d\\'e'}", '{"a\'b":"c\\"d\'e"}'],
  ['line continuations', '{"a": "hello \\\nworld", "b": "x\\\r\ny", "c": "p\\\u2028q"}', '{"a":"hello world","b":"xy","c":"pq"}'],
  ['special escapes \\x, \\v, \\0, non-escape', '{"a": "\\x41\\v\\0\\a\\/"}', '{"a":"\\u0041\\u000b\\u0000a/"}'],
  ['raw control chars inside JSON5 string', '{"a": "x\ty\bz"}', '{"a":"x\\ty\\bz"}'],
  ['hex integers and negative zero hex', '[0xFF, +0x10, -0x1A, -0x0, 0X0]', '[255,16,-26,-0,0]'],
  ['large hex integer precision via BigInt', '[0x1FFFFFFFFFFFFF1, -0x1FFFFFFFFFFFFF1]', '[144115188075855857,-144115188075855857]'],
  ['leading plus, leading dot, trailing dot', '[+1, +0, .5, -.5, +.5, 5., -5., +5., 5.e2, -0.]', '[1,0,0.5,-0.5,0.5,5,-5,5,5e2,-0]'],
  ['preserved standard number literals', '[9007199254740993, 1.10, 1e400, -0, 1E+02]', '[9007199254740993,1.10,1e400,-0,1E+02]'],
  ['extra JSON5 whitespace', '\ufeff\u00a0\v\f\u2028\u2029\u3000{\u00a0a:\v1\f}', '{"a":1}'],
  ['empty containers and primitives', '/*c*/[]', '[]'],
  ['empty object with comment', '{/*empty*/}', '{}'],
  ['TASKS acceptance example', "{a: 1, 'b': [0xFF, .5,],}", '{"a":1,"b":[255,0.5]}'],
];

for (const [name, input, expected] of CONVERSION_CASES) {
  test(`converts ${name}`, () => {
    const { text } = convertLenientJson(input);
    assert.equal(text, expected);
    JSON.parse(text);
  });
}

test('converts VS Code settings.json with comments and trailing commas', () => {
  const settings = `{
    // Editor settings
    "editor.tabSize": 2,
    /* Multi-line
       comment */
    'editor.insertSpaces': true,
    "files.exclude": {
      "**/.git": true,
    },
  }`;
  const { text } = convertLenientJson(settings);
  const formatted = formatJson(text, { indent: '2' }).text;
  assert.deepEqual(JSON.parse(formatted), {
    'editor.tabSize': 2,
    'editor.insertSpaces': true,
    'files.exclude': { '**/.git': true },
  });
});

test('reports exact source positions for errors and non-finite values', () => {
  const cases = [
    ['unclosed block comment', '{\n  /* unclosed\n  "a": 1}', 4, 2, 3],
    ['Infinity', '{"a": Infinity}', 6, 1, 7],
    ['-Infinity', '{\n  "a": -Infinity\n}', 9, 2, 8],
    ['+Infinity', '[+Infinity]', 1, 1, 2],
    ['NaN', '[NaN]', 1, 1, 2],
    ['-NaN', '[-NaN]', 1, 1, 2],
    ['invalid identifier start', '{\n  123: 1}', 4, 2, 3],
    ['invalid unicode escape in key', '{\\u0020: 1}', 1, 1, 2],
    ['leading zero number', '[01]', 2, 1, 3],
    ['octal escape \\01', '["\\01"]', 2, 1, 3],
    ['octal escape \\1', '["\\1"]', 2, 1, 3],
    ['invalid hex escape', '["\\x4G"]', 2, 1, 3],
    ['empty comma', '[,]', 1, 1, 2],
    ['double comma', '[1,,2]', 3, 1, 4],
    ['unescaped newline in string', "['a\nb']", 3, 1, 4],
    ['empty input', '// only comment\n', 16, 2, 1],
    ['trailing token', '{"a":1} extra', 8, 1, 9],
  ];
  for (const [label, input, pos, line, col] of cases) {
    assert.throws(
      () => convertLenientJson(input),
      (err) => {
        assert.ok(err instanceof SyntaxError, label);
        assert.equal(err.code, 'INVALID_JSON', label);
        assert.match(err.message, /JSON/, label);
        assert.doesNotMatch(err.message, /[\u3400-\u9fff]/, label);
        assert.deepEqual([err.position, err.line, err.column], [pos, line, col], label);
        return true;
      },
    );
  }
});

test('mapOffset maps converted JSON positions back to original offsets', () => {
  const input = '/*c*/ { a: 0xFF, b: "x" }';
  const { text, mapOffset } = convertLenientJson(input);
  assert.equal(text, '{"a":255,"b":"x"}');
  assert.equal(mapOffset(0), input.indexOf('{'));
  assert.equal(mapOffset(text.indexOf('255')), input.indexOf('0xFF'));
  assert.equal(mapOffset(text.indexOf('"x"')), input.indexOf('"x"'));
  assert.equal(mapOffset(text.length), input.length);
});

test('handles deeply nested JSON5 iteratively without stack overflow and trackOffsets: false', () => {
  const depth = 20_000;
  const input = '['.repeat(depth) + '0x10,' + ']'.repeat(depth);
  const { text } = convertLenientJson(input);
  assert.equal(text, '['.repeat(depth) + '16' + ']'.repeat(depth));

  const untracked = convertLenientJson('/*c*/ { a: 0xFF, b: [1, 2,], }', { trackOffsets: false });
  assert.equal(untracked.text, '{"a":255,"b":[1,2]}');
  assert.equal(untracked.mapOffset(4), 4);
});
