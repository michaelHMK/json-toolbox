import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { emitYaml } from '../src/core/yaml-emit.js';
import { yamlToJson, YAML_MAX_INPUT_BYTES } from '../src/core/yaml-to-json.js';
import { parseJsonPreservingNumberLiterals } from '../src/core/json.js';
import { parseAllDocuments } from '../src/vendor/yaml.js';

const TRICKY_STRINGS = [
  '',
  ' ',
  '  leading',
  'trailing  ',
  'true',
  'True',
  'TRUE',
  'false',
  'False',
  'null',
  'NULL',
  '~',
  'yes',
  'YES',
  'no',
  'NO',
  'on',
  'ON',
  'off',
  'OFF',
  'y',
  'Y',
  'n',
  'N',
  '0123',
  '1_000',
  '1:20',
  '190:20:30',
  '1.0',
  '.inf',
  '+.inf',
  '-.Inf',
  '.nan',
  '0x1F',
  '0o755',
  '0b101',
  '2026-11-28',
  '2026-11-28T12:00:00Z',
  '-dash',
  '?question',
  ':colon',
  ',comma',
  '[bracket',
  ']close',
  '{brace',
  '}close',
  '#comment',
  '&anchor',
  '*alias',
  '!tag',
  '|pipe',
  '>fold',
  "'single",
  '"double',
  '%percent',
  '@at',
  '`backtick',
  '---',
  '...',
  'key:',
  'foo: bar',
  'foo #bar',
  'a\tb\u0000c\u2028d\u2029e',
  'line1\nline2',
  'line1\nline2\n',
  'line1\nline2\n\n',
  '  indented\nline2',
  '\n  indented\n',
  ' \n',
  '  \n',
  ' \n ',
  '\n ',
  ' \n\n',
  '\n',
  'x'.repeat(1100),
];

test('emitYaml quotes YAML 1.1/1.2 ambiguous scalars and round-trips through yaml 1.2', () => {
  for (const s of TRICKY_STRINGS) {
    const yaml = emitYaml({ [s]: s });
    const parsed = parseAllDocuments(yaml, { schema: 'core' });
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0].errors, [], `YAML errors for ${JSON.stringify(s)}:\n${yaml}`);
    assert.deepEqual(parsed[0].toJS(), { [s]: s }, `Round-trip mismatch for ${JSON.stringify(s)}:\n${yaml}`);

    const back = JSON.parse(yamlToJson(yaml).text);
    assert.deepEqual(back, { [s]: s });
  }
});

test('emitYaml uses flow style for empty containers and block scalars with chomping/indent indicators', () => {
  assert.equal(emitYaml({ arr: [], obj: {} }), 'arr: []\nobj: {}\n');
  assert.equal(emitYaml({ a: 'x\ny' }), 'a: |-\n  x\n  y\n');
  assert.equal(emitYaml({ a: 'x\ny\n' }), 'a: |\n  x\n  y\n');
  assert.equal(emitYaml({ a: 'x\ny\n\n' }), 'a: |+\n  x\n  y\n\n');
  assert.equal(emitYaml({ a: '  lead\nx' }), 'a: |2-\n    lead\n  x\n');
});

test('emitYaml and yamlToJson preserve number literals across both directions', () => {
  const input = '{"big":9007199254740993,"dec":1.10,"huge":1e400,"negZero":-0}';
  const { data, numberLiterals } = parseJsonPreservingNumberLiterals(input);
  const yaml = emitYaml(data, { numberLiterals });
  assert.match(yaml, /big: 9007199254740993/);
  assert.match(yaml, /dec: 1\.10/);
  assert.match(yaml, /huge: 1e400/);
  assert.match(yaml, /negZero: -0/);

  const back = yamlToJson(yaml, { indent: null }).text;
  assert.equal(back, input);
});

test('yamlToJson implements core schema, alias expansion, multi-doc, scalar keys and strict rejections', () => {
  // Timestamps stay strings in core schema.
  const ts = yamlToJson('date: 2026-11-28\ntime: 2026-11-28T10:20:30Z\n', { indent: null });
  assert.equal(ts.text, '{"date":"2026-11-28","time":"2026-11-28T10:20:30Z"}');
  assert.equal(ts.multiDocument, false);

  // Anchors and aliases expand.
  const aliased = yamlToJson('defaults: &def\n  port: 8080\nservice: *def\n', { indent: null });
  assert.deepEqual(JSON.parse(aliased.text), { defaults: { port: 8080 }, service: { port: 8080 } });

  // Non-string scalar keys coerce to strings while preserving numeric spelling.
  const scalarKeys = yamlToJson('1: one\ntrue: yes\n9007199254740993: big\n', { indent: null });
  assert.equal(scalarKeys.text, '{"1":"one","true":"yes","9007199254740993":"big"}');

  // Multi-document YAML becomes a JSON array.
  const multi = yamlToJson('a: 1\n---\nb: 2\n', { indent: '2' });
  assert.equal(multi.multiDocument, true);
  assert.equal(multi.documentCount, 2);
  assert.deepEqual(JSON.parse(multi.text), [{ a: 1 }, { b: 2 }]);

  // YAML hex/octal/leading-dot numbers become standard JSON.
  assert.equal(yamlToJson('[0x1F, 0o10, .5, 5., +1, 0123]', { indent: null }).text, '[31,8,0.5,5,1,123]');
});

test('yamlToJson rejects billion laughs, circular aliases, complex keys, non-finite numbers and custom tags with positions', () => {
  const billionLaughs = [
    'a: &a ["lol","lol","lol"]',
    'b: &b [*a,*a,*a,*a,*a]',
    'c: &c [*b,*b,*b,*b,*b]',
    'd: &d [*c,*c,*c,*c,*c]',
    'e: [*d,*d,*d,*d,*d]',
  ].join('\n');
  assert.throws(() => yamlToJson(billionLaughs), (err) => err.code === 'YAML_ALIAS_LIMIT');
  assert.throws(() => yamlToJson('a: &a [*a]'), (err) => err.code === 'YAML_ALIAS_LIMIT');

  const cases = [
    ['complex key', 'a: 1\n[1, 2]: 3\n', 'YAML_COMPLEX_KEY', 2, 1],
    ['.inf', 'x: 1\ny: .inf\n', 'YAML_NON_FINITE', 2, 4],
    ['-.Inf', 'y: -.Inf\n', 'YAML_NON_FINITE', 1, 4],
    ['.nan', 'y: .nan\n', 'YAML_NON_FINITE', 1, 4],
    ['!!float ".inf"', 'y: !!float ".inf"\n', 'YAML_NON_FINITE', 1, 12],
    ['!!float ".nan"', 'y: !!float ".nan"\n', 'YAML_NON_FINITE', 1, 12],
    ['!!binary', 'b: !!binary SGVsbG8=\n', 'YAML_UNSUPPORTED_TAG', 1, 13],
    ['!custom', 'c: !custom val\n', 'YAML_UNSUPPORTED_TAG', 1, 12],
    ['!!timestamp', 't: !!timestamp 2026-11-28\n', 'YAML_UNSUPPORTED_TAG', 1, 16],
    ['syntax error', 'a:\n  b: 1\n c: 2\n', 'INVALID_YAML', 3, 1],
  ];
  for (const [label, input, code, line, col] of cases) {
    assert.throws(
      () => yamlToJson(input),
      (err) => {
        assert.equal(err.code, code, label);
        assert.equal(err.line, line, `${label} line`);
        assert.equal(err.column, col, `${label} col`);
        return true;
      },
    );
  }
});

test('yamlToJson normalizes overflowing numeric forms, explicit typed scalars and size limits', () => {
  const hugeHex = '0x' + 'f'.repeat(80);
  const hugeOct = '0o' + '7'.repeat(90);
  const yaml = [
    'dotTrail: 1.e400',
    'dotLead: .5e400',
    'zeroPad: 001e400',
    'typedFloat: !!float "1e400"',
    'typedInt: !!int "0x10"',
    `hugeHex: ${hugeHex}`,
    `hugeOct: ${hugeOct}`,
  ].join('\n');
  const out = yamlToJson(yaml, { indent: null }).text;
  assert.equal(
    out,
    `{"dotTrail":1e400,"dotLead":0.5e400,"zeroPad":1e400,"typedFloat":1e400,"typedInt":16,"hugeHex":${BigInt(hugeHex)},"hugeOct":${BigInt(hugeOct)}}`,
  );
  assert.doesNotThrow(() => JSON.parse(out));

  assert.equal(YAML_MAX_INPUT_BYTES, 10 * 1024 * 1024);
  assert.throws(
    () => yamlToJson('a: ' + 'x'.repeat(120), { maxInputBytes: 64 }),
    (err) => err.code === 'YAML_INPUT_TOO_LARGE',
  );
});

test('TASKS acceptance: ambiguous strings stay strings in yaml 1.2 and PyYAML 1.1', () => {
  const input = '{"country":"NO","v":"1.0","port":"0123"}';
  const { data, numberLiterals } = parseJsonPreservingNumberLiterals(input);
  const yaml = emitYaml(data, { numberLiterals });
  assert.deepEqual(parseAllDocuments(yaml, { schema: 'core' })[0].toJS(), { country: 'NO', v: '1.0', port: '0123' });

  let hasPyYaml = false;
  try {
    execFileSync('python3', ['-c', 'import yaml'], { stdio: 'ignore' });
    hasPyYaml = true;
  } catch {
    hasPyYaml = false;
  }
  if (hasPyYaml) {
    const pyOut = execFileSync('python3', ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(sys.stdin.read())))'], {
      input: yaml,
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(pyOut), { country: 'NO', v: '1.0', port: '0123' });
  }
});

test('TASKS acceptance: Kubernetes Deployment YAML round-trips semantically unchanged', () => {
  const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
  labels:
    app: web
    country: "NO"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: nginx
          image: nginx:1.25
          ports:
            - containerPort: 80
          env:
            - name: ENABLED
              value: "true"
`;
  const json1 = yamlToJson(deployment, { indent: '2' }).text;
  const { data, numberLiterals } = parseJsonPreservingNumberLiterals(json1);
  const yamlBack = emitYaml(data, { numberLiterals });
  const json2 = yamlToJson(yamlBack, { indent: '2' }).text;
  assert.equal(json2, json1);
});

test('seeded property test: random JSON -> YAML -> JSON preserves exact structure and number literals', () => {
  let seed = 0x5eed1234;
  function rand() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  function pick(list) {
    return list[Math.floor(rand() * list.length)];
  }
  const numTokens = ['0', '-0', '42', '9007199254740993', '1.10', '1e400', '-12.340'];

  function genJsonValue(depth) {
    const kind = depth >= 3 ? Math.floor(rand() * 4) : Math.floor(rand() * 6);
    if (kind === 0) return 'null';
    if (kind === 1) return rand() < 0.5 ? 'true' : 'false';
    if (kind === 2) return pick(numTokens);
    if (kind === 3) return JSON.stringify(pick(TRICKY_STRINGS));
    if (kind === 4) {
      const len = Math.floor(rand() * 4);
      return '[' + Array.from({ length: len }, () => genJsonValue(depth + 1)).join(',') + ']';
    }
    const len = Math.floor(rand() * 4);
    const entries = new Map();
    for (let k = 0; k < len; k++) {
      // Avoid duplicate keys so JSON key ordering stays deterministic across round-trips.
      const key = pick(TRICKY_STRINGS).slice(0, 64) + '_' + k;
      entries.set(key, genJsonValue(depth + 1));
    }
    // Match Object.keys order (non-array-index strings in insertion order).
    return '{' + [...entries.entries()].map(([k, v]) => JSON.stringify(k) + ':' + v).join(',') + '}';
  }

  for (let trial = 0; trial < 80; trial++) {
    const compactJson = genJsonValue(0);
    const { data, numberLiterals } = parseJsonPreservingNumberLiterals(compactJson);
    const yaml = emitYaml(data, { numberLiterals });
    const roundTripped = yamlToJson(yaml, { indent: null }).text;
    assert.equal(roundTripped, compactJson, `Trial ${trial} mismatch:\nJSON: ${compactJson}\nYAML:\n${yaml}`);
  }
});

test('deeply nested JSON emits iteratively and deep YAML round-trips cleanly', () => {
  const emitDepth = 5000;
  const deepJson = '['.repeat(emitDepth) + '42' + ']'.repeat(emitDepth);
  const parsed = parseJsonPreservingNumberLiterals(deepJson);
  const deepYaml = emitYaml(parsed.data, { numberLiterals: parsed.numberLiterals });
  assert.ok(deepYaml.length > emitDepth * 2);

  const depth = 400;
  const json = '['.repeat(depth) + '42' + ']'.repeat(depth);
  const { data, numberLiterals } = parseJsonPreservingNumberLiterals(json);
  const yaml = emitYaml(data, { numberLiterals });
  assert.equal(yamlToJson(yaml, { indent: null }).text, json);
});
