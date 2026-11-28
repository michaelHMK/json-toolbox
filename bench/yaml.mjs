import { parseJsonPreservingNumberLiterals } from '../src/core/json.js';
import { emitYaml } from '../src/core/yaml-emit.js';
import { yamlToJson } from '../src/core/yaml-to-json.js';
import { createFormatSource } from './format-data.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')));
const sizeMiB = Number(args['size-mib'] || 25);
const yamlSizeMiB = Number(args['yaml-size-mib'] || 5);
const samples = Number(args.samples || 3);

const text = createFormatSource('canon', sizeMiB);
const timings = [];
let outputLength = 0;

// Warm up JIT.
const warm = parseJsonPreservingNumberLiterals('[{"id":1,"value":1.20}]');
const warmYaml = emitYaml(warm.data, { numberLiterals: warm.numberLiterals });
yamlToJson(warmYaml, { indent: '2' });

for (let i = 0; i < samples; i++) {
  globalThis.gc?.();
  const start = performance.now();
  const { data, numberLiterals } = parseJsonPreservingNumberLiterals(text);
  const yaml = emitYaml(data, { numberLiterals });
  timings.push(performance.now() - start);
  outputLength = yaml.length;
}
timings.sort((a, b) => a - b);
console.log(JSON.stringify({
  scenario: 'json-to-yaml',
  node: process.version,
  inputMiB: +(Buffer.byteLength(text) / 1024 / 1024).toFixed(2),
  outputLength,
  medianMs: +timings[Math.floor(samples / 2)].toFixed(2),
  peakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(2),
}));

const yamlSourceJson = parseJsonPreservingNumberLiterals(createFormatSource('canon', yamlSizeMiB));
const yamlInput = emitYaml(yamlSourceJson.data, { numberLiterals: yamlSourceJson.numberLiterals });
const y2jTimings = [];
let y2jOutputLength = 0;
for (let i = 0; i < samples; i++) {
  globalThis.gc?.();
  const start = performance.now();
  const res = yamlToJson(yamlInput, { indent: '2' });
  y2jTimings.push(performance.now() - start);
  y2jOutputLength = res.text.length;
}
y2jTimings.sort((a, b) => a - b);
console.log(JSON.stringify({
  scenario: 'yaml-to-json',
  node: process.version,
  inputMiB: +(Buffer.byteLength(yamlInput) / 1024 / 1024).toFixed(2),
  outputLength: y2jOutputLength,
  medianMs: +y2jTimings[Math.floor(samples / 2)].toFixed(2),
  peakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(2),
}));
