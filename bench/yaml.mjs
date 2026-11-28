import { parseJsonPreservingNumberLiterals } from '../src/core/json.js';
import { emitYaml } from '../src/core/yaml-emit.js';
import { createFormatSource } from './format-data.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')));
const sizeMiB = Number(args['size-mib'] || 25);
const samples = Number(args.samples || 3);

const text = createFormatSource('canon', sizeMiB);
const timings = [];
let outputLength = 0;

// Warm up JIT.
const warm = parseJsonPreservingNumberLiterals('[{"id":1,"value":1.20}]');
emitYaml(warm.data, { numberLiterals: warm.numberLiterals });

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
