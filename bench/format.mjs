import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFormatSource, FORMAT_CASES } from './format-data.mjs';

// Each operation runs in its own process so peak RSS is comparable. Example:
// node --expose-gc bench/format.mjs --size-mib=25 --samples=3 --assert-ratio=2.5
// --module=file:///path/to/baseline/json.js runs the same fixture against a baseline.
const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=')));
const { formatJson } = await import(args.module || new URL('../src/core/json.js', import.meta.url).href);
const sizeMiB = Number(args['size-mib'] || 5);
const samples = Number(args.samples || 3);
if (!(sizeMiB > 0 && Number.isInteger(samples) && samples > 0)) throw new Error('Invalid benchmark size or sample count');

if (args.child) {
  const text = createFormatSource(args.case, sizeMiB);
  const run = args.child === 'native' ? () => JSON.stringify(JSON.parse(text), null, 2)
    : args.child === 'nativeMinify' ? () => JSON.stringify(JSON.parse(text))
      : () => formatJson(text, { indent: args.child === 'minify' ? null : '2', includeNumberLiterals: args.child === 'tree' }).text;
  // Warm up the scanner without retaining a second full-size output.
  formatJson('[{"value":1.20,"nested":[1,2,3]}]');
  const timings = [];
  let outputLength;
  for (let i = 0; i < samples; i++) {
    globalThis.gc?.();
    const start = performance.now();
    const output = run();
    timings.push(performance.now() - start);
    outputLength = output.length;
  }
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ medianMs: +timings[Math.floor(samples / 2)].toFixed(2), peakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(2), inputMiB: +(Buffer.byteLength(text) / 1024 / 1024).toFixed(2), outputLength }));
} else {
  for (const name of args.case ? [args.case] : FORMAT_CASES) {
    const results = {};
    for (const operation of ['native', 'format', 'tree', 'nativeMinify', 'minify']) {
      const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), `--child=${operation}`, `--case=${name}`, `--size-mib=${sizeMiB}`, `--samples=${samples}`, ...(args.module ? [`--module=${args.module}`] : [])], { encoding: 'utf8' });
      if (child.status !== 0) throw new Error(child.stderr || `Benchmark exited ${child.status}`);
      results[operation] = JSON.parse(child.stdout);
    }
    const formatRatio = +(results.format.medianMs / results.native.medianMs).toFixed(2);
    const minifyRatio = +(results.minify.medianMs / results.nativeMinify.medianMs).toFixed(2);
    console.log(JSON.stringify({ name, node: process.version, formatRatio, minifyRatio, ...results }));
    if (args['assert-ratio'] && (formatRatio > Number(args['assert-ratio']) || minifyRatio > Number(args['assert-ratio']))) {
      process.exitCode = 1;
    }
  }
}
