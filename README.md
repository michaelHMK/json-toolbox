# JSON Toolbox

English | [简体中文](README.zh-CN.md)

**Built for large JSON. All processing stays local.**

JSON Toolbox is a Chrome extension (Manifest V3) built around performance and privacy, with tools to format, minify, escape, and compare JSON. Zero permissions, uploads, or tracking. No ads or third-party runtime dependencies. Works offline after installation.

See the `version` field in [`src/manifest.json`](src/manifest.json) for the current version.

## Performance for Large JSON

- **Responsive interactions**: Web Workers handle parsing, search, and comparison, reducing computation on the main thread.
- **Lightweight browsing**: trees and long text render only around the visible area, avoiding a DOM node for every result while supporting tree search navigation and full copying.
- **Large-input virtualization**: inputs above 262,144 UTF-16 code units (about 256 KiB for ASCII text) use a read-only virtual preview, avoiding full native textarea layout.
- **Less repeated work**: ordinary documents reuse parsed data and results; large text-only operations choose native or direct serialization for the data, fall back to iteration for deep nesting, and release unused Worker document caches.

See [Performance Checks](#performance-checks) below for verification commands and large-output limitations.

## Privacy

- **No uploads or tracking**: the extension makes no network requests, loads no remote code, and includes no telemetry, ads, or third-party SDKs.
- **No extra extension permissions**: no website access or storage permissions, and no reading of website content, browsing history, cookies, or account information. See [`src/manifest.json`](src/manifest.json).
- **No saved input history**: inputs and results are processed only in the memory of the tool page and its local Worker. The extension does not write them to browser storage, files, or cloud services; it writes to the system clipboard only when you copy.
- **Local theme preference**: only your theme choice is saved in `localStorage` on your device. This does not save input content or require additional extension permissions.

See the [privacy policy](PRIVACY.md) for full data-handling details. Use the [publicly hosted version](https://github.com/michaelHMK/json-toolbox/blob/main/PRIVACY.md) for the store listing.

## Features

| Tool | Features |
| --- | --- |
| **JSON Formatter** | Pretty-print with 2 spaces, 4 spaces, or tabs; report syntax errors and show line/column positions with cursor navigation when available; browse collapsible trees, expand by depth, search keys and values, navigate highlighted matches, and copy results |
| **JSON Minifier** | Remove whitespace to produce a single line; report invalid JSON with line/column positions when available |
| **JSON Escape / Unescape** | Convert between plain text and escaped JSON string content, with one-click copying |
| **JSON Compare** | Compare JSON structures for additions, removals, value changes, and type changes; match array elements by index or key; ignore selected paths; highlight differences in trees, show only differences, and compare text line by line |

Formatter, Minifier, and both Compare inputs accept local UTF-8 `.json` files (up to 50 MiB per file) through file pickers or drag-and-drop. Importing preserves the original text and runs the operation; Compare runs once both inputs are present. Large pastes and plain-text drops also use the virtual preview. Large inputs remain in a read-only virtual preview, including syntax-error navigation when the browser provides a position.

Use the sidebar to switch between tools. The interface includes 20 locale catalogs in `src/_locales/`: English (`en`), Simplified Chinese (`zh_CN`), Traditional Chinese for Taiwan (`zh_TW`) and Hong Kong (`zh_HK`), Japanese (`ja`), Korean (`ko`), German (`de`), French (`fr`), Spanish (`es`) and Latin American Spanish (`es_419`), Portuguese for Brazil (`pt_BR`) and Portugal (`pt_PT`), Russian (`ru`), Arabic (`ar`), Indonesian (`id`), Vietnamese (`vi`), Italian (`it`), Romanian (`ro`), Turkish (`tr`), and Polish (`pl`). Chrome chooses translations from its UI language, with English as the default. Static page text also falls back to English when the extension API is unavailable. Arabic uses a right-to-left interface; JSON input, output, and trees remain left-to-right.

Choose **Normal**, **Eye comfort**, or **Dark** under **Appearance** in the sidebar. The default is Normal. Your choice is remembered locally across tool pages and after reopening the extension.

## Load Locally (Developer Mode)

1. Open Chrome and go to `chrome://extensions/`.
2. Enable **Developer mode** in the upper-right corner.
3. Click **Load unpacked**.
4. Select the repository's **`src/` directory**, which contains `manifest.json`.
5. Click the extension icon in the toolbar to open JSON Toolbox.

Keyboard shortcut: most pages support **Cmd/Ctrl + Enter** to run the current operation.

Use **Tab** to enter a JSON tree. **Up/Down** move between visible nodes, **Right/Left** expand or collapse a branch and move to its child or parent, and **Home/End** move to the first or last visible node. **Enter/Space** toggle a branch. **Tab** leaves the tree.

## Project Structure

```
src/                   # Complete extension; load this directory in Chrome
  manifest.json        # Extension manifest
  *.html               # Stable entry points for the five tool pages
  background.js        # Service Worker: opens the toolbox when the extension icon is clicked
  pages/               # Page interactions, view state, and rendering
    formatter.js
    compare.js
    transform.js       # Shared page logic for minify, escape, and unescape
  shared/              # Browser UI, document/comparison sessions, and Worker transport
  core/                # Pure algorithms: JSON formatting, paths, search, structural/text diff
  worker/
    index.js           # Web Worker message entry point
    tasks.js           # Task dispatch, cached search data, and error responses
  styles/
    app.css            # Single CSS entry point; imports the styles below in order
    themes.css         # Theme tokens
    base.css           # Global defaults
    layout.css         # Shared application layout
    components/        # Navigation, theme picker, controls, editor, tree, text view
    pages/             # Formatter and comparison page styles
  icons/               # Extension icons referenced by the manifest
  _locales/            # Translations
scripts/
  build_release.py     # Release validation and allowlist packaging using Python's standard library
  gen_icons.py         # Regenerate PNG files in src/icons/ (optional)
  store-assets/        # Store screenshot and promotional image generators
tests/                 # Algorithm and messaging contracts, release validation
bench/                 # Formatting/search/diff benchmarks and optional browser checks
package.json           # Native ES modules and development commands; no third-party dependencies
STORE_LISTING.md       # Chrome Web Store listing copy and submission guidance
PRIVACY.md             # English and Chinese privacy policy hosted in the public repository
store-assets/          # Store screenshots, promotional images, and listing copy; excluded from the extension ZIP
dist/                  # Generated extension ZIP and checksum; ignored by Git
```

All extension runtime files live under `src/`; development tools and store materials stay outside it. Page logic uses native browser ES modules. No dependency installation or build step is needed to load the extension. Each HTML page has one entry module for page logic; a separate theme bootstrap script restores the saved appearance before the first paint. Navigation is rendered before translations are applied.

Every page loads `styles/app.css`, which only declares ordered CSS imports. Shared component rules live in `styles/components/`, page-specific rules in `styles/pages/`, and theme tokens in `styles/themes.css`. Tree styling, including virtual rows and keyboard focus, belongs to the tree component.

| Boundary | Responsibilities and contracts |
| --- | --- |
| `pages → shared` | Pages own interaction and view state; shared modules handle browser interactions and virtual rendering. The formatter and comparison trees retain their own expansion, search navigation, and difference presentation. |
| `pages → document-session / comparison-session` | The formatter and comparison pages request document operations through their sessions. Sessions own Worker snapshots, cancellation and recovery, and rejection of stale responses; pages do not handle snapshot ids or rebuild discarded Worker data themselves. |
| `pages/shared → core` | Views use JSON Pointer encoding and line-offset indexes. JSON parsing, search, and comparison run in the Worker. |
| `shared/worker-client → worker/index` | Transport matches requests by id, manages the serial queue, and reports busy/reset events. Queues coalesce unsent work by key; discarded requests carry `cancelled: true`. Document lifecycle and recovery belong to the sessions. |
| `worker/tasks → core` | Each Worker caches its current document/comparison. Sessions use `retainSnapshot`/`snapshotId` to reuse parsing; `includeData: false` omits object transfer. Large documents keep their tree model in the Worker and return windows of at most 256 rows; small documents use synchronous trees. Clear invalidates snapshots, and the minify page does not retain unused search data. |
| `core` | Algorithms do not depend on the DOM, Chrome APIs, or Worker globals. Invalid input throws an exception, which the task layer converts to an error response. Scanning and restoring original number literals is centralized in `json.js`. |

Shared virtual renderers own viewport indexing and DOM lifecycles; pages retain their distinct search, pairing, filtering, and navigation behavior. To add a task, place its algorithm in `src/core/` and connect it through `src/worker/tasks.js`. Add any new runtime files to the allowlist in `scripts/build_release.py` as well.

## Development Checks

Run the following commands from the repository root. Requires Node.js 20+ and Python 3; no `npm install` is needed:

```bash
npm test
python3 scripts/build_release.py --check
```

Tests cover number literals and special keys, cached search data and result limits, structural and text comparisons, concurrent Worker requests and failure responses, and transitive module and stylesheet dependencies in the release package. Browser interactions should also be checked using the checklist below.

See [AGENTS.md](AGENTS.md#测试维护) for test ownership and maintenance rules. Extend existing behavior coverage before adding a new suite; keep algorithm edge cases in the algorithm tests and integration tests focused on their own boundaries.

### Performance Checks

Run `npm run bench` for deterministic formatting, minifying, search, and diff benchmarks. Compare runs sequentially in the same environment. `npm run bench:budget` uses the median of three samples on 25 MiB fixtures and requires formatting/minifying time to stay within 3 times native parse/stringify time; CI runs this check.

The formatting benchmark runs each operation in a separate process. Peak RSS includes the process baseline, fixture generation, and V8 memory; it does not measure retained application memory or establish a whole-page memory-to-input ratio.

Optional browser checks require an existing Playwright installation and Chromium:

```bash
# Omit this if Playwright is already importable locally.
export PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs
# Optional browser override: export CHROMIUM_EXECUTABLE=/path/to/chromium
node bench/browser.mjs . --verify
node bench/accessibility.mjs .
node bench/file-import.mjs .
node bench/text-view.mjs
node bench/tree-view.mjs
node bench/worker-transfer.mjs
node bench/performance.mjs
node bench/remote-pages.mjs
node bench/remote-state.mjs
node bench/input-focus.mjs
node bench/theme.mjs
```

Browser check directory arguments such as `.` refer to a checkout; the scripts load its `src/` extension directory and also recognize the root layout of older checkouts. You can pass an extension directory directly.

These checks cover large file imports, virtual inputs, large text and trees, navigation, copying, focus, view switching, state recovery, and deeply nested Worker transfers. `performance.mjs` uses local HTTP pages and real Workers; its timings exclude extension installation, startup, and system clipboard access. Paste/drop events are synthesized to measure application event handling.

`TREE_TOGGLE_BUDGET_MS`, `PERF_INPUT_BUDGET_MS`, and `PERF_FRAME_BUDGET_MS` adjust the synchronous tree-toggle p50, input-processing/layout, and scrolling-frame p95 budgets (defaults: 16, 50, and 35 ms). The dense-diff check in `remote-state.mjs` enforces a scrolling budget; initial comparison and Worker recovery are reported separately.

The accessibility check uses the English and Arabic catalogs through a simulated extension i18n API to verify layout, keyboard navigation, and Chromium's accessibility tree. It does not replace manual screen-reader testing.

The file-import benchmark runs both pages three times per scenario and reports each sample plus medians. Its default scenarios are a 50 MiB ordinary document (`regular`), a 4 MiB array with preserved `1.20` literals (`decimals`), and a 50 MiB invalid single line (`invalid`). Fixture and `File` construction happen before measurement; elapsed time includes two animation frames after success/error feedback, and Long Tasks cover only the measured import. Complete input/output copying and error-location checks run afterward. Heap readings include the benchmark fixture; slower cross-agent memory measurement is opt-in with `BENCH_MEMORY=1`.

```bash
# Choose scenarios/actions, sizes and repetition count.
BENCH_SCENARIOS=regular,decimals,invalid BENCH_REPEATS=3 node bench/file-import.mjs .
BENCH_SCENARIOS=decimals BENCH_ACTIONS=minify BENCH_DECIMAL_MIB=4 node bench/file-import.mjs .
# Optional deep case: 10,000 nested arrays, padded past the large-input threshold.
# Formatting produces about 191 MiB of output; run it separately.
BENCH_SCENARIOS=deep BENCH_DEEP_DEPTH=10000 BENCH_REPEATS=1 node bench/file-import.mjs .
# Use the same script against an older checkout; report old behavior without failing checks.
BENCH_VERIFY=0 node bench/file-import.mjs /path/to/baseline-checkout
```

`BENCH_FILE_MIB` changes the ordinary/invalid file size (default `50`). `BENCH_VERIFY=0` still records correctness failures. Optional `BENCH_MAX_MS` and `BENCH_MAX_LONG_TASK_MS` enforce budgets against the median total time and median longest task respectively; both are disabled by default because hardware and browser versions vary. Run baseline and updated checkouts sequentially with identical settings.

Large inputs and outputs use virtual rendering, so native browser Find covers only the visible window. Tree search and full copying remain available. Complete input and result text stays in page memory, while parsed object graphs and tree indexes for large documents stay in the Worker. Large text diffs use block replacement.

For normal use, load the extension as described above. To preview the pages, run `python3 -m http.server 8000 --directory src` and visit `http://localhost:8000/formatter.html`. Native modules cannot be loaded by opening the HTML files directly through `file://`, and HTTP previews do not provide Chrome's extension internationalization API.

## Regenerate Icons

Requires Python 3 with no third-party dependencies:

```bash
python3 scripts/gen_icons.py
```

The output directory is `src/icons/`. Existing PNG files are overwritten.

## Build a Release

Requires Python 3 with no third-party dependencies:

```bash
python3 scripts/build_release.py --check
python3 scripts/build_release.py
```

The script validates the version, name and description lengths in all locale catalogs, translation keys, icon dimensions, HTML resource references, and relative paths for JavaScript static imports, the Worker entry point, and CSS `@import`/`url()` dependencies. It then packages runtime files from `src/` using an explicit allowlist. Output is written to `dist/json-toolbox-<version>.zip` with a matching `.zip.sha256` checksum file. The ZIP contains `manifest.json` at its root, without an enclosing `src/` directory, and excludes tests, documentation, screenshots, development configuration, and `.git`. The `dist/` directory is ignored by Git.

Before uploading, extract the ZIP to a new directory, load that directory through `chrome://extensions/`, and complete the checks below. For subsequent releases, increase the version in `src/manifest.json` before rebuilding.

### First Store Submission

1. Register an account in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/), read and accept the agreement, and pay the one-time registration fee shown there. See the [registration instructions](https://developer.chrome.com/docs/webstore/register).
2. Set your publisher name, verify your contact email, and complete the account details requested by the dashboard. Enable two-step verification on your Google account, as required by the [publishing policy](https://developer.chrome.com/docs/webstore/program-policies/two-step-verification).
3. Use the [public privacy policy URL](https://github.com/michaelHMK/json-toolbox/blob/main/PRIVACY.md), hosted in this repository. To update the public policy, edit [PRIVACY.md](PRIVACY.md) and merge the change into `main` through a pull request. Confirm that the link is accessible in a signed-out browser window before submitting.
4. Create a store listing and upload the extension ZIP from `dist/`. Follow [STORE_LISTING.md](STORE_LISTING.md) for English and Chinese descriptions, privacy declarations, and testing instructions. Upload the images for each language from `store-assets/`.
5. Choose distribution regions and public visibility, review the preview, and submit for review. You can publish automatically after approval or publish manually; see the [official publishing process](https://developer.chrome.com/docs/webstore/publish).

### Pre-Upload Functional Checklist

- Click the extension icon to open the toolbox and confirm that the extension management page shows no loading errors.
- Check all three indentation options, invalid JSON location reporting, tree expansion, search, copying, and clearing.
- Check minify, escape, and unescape with newlines, quotes, backslashes, and Unicode text.
- Check additions, removals, value changes, and type changes in JSON Compare, along with array key matching, ignored paths, differences-only mode, and text comparison.
- Check English, Chinese, and Arabic interface text, including right-to-left layout, left-to-right code, and translated accessible names. Check keyboard tree navigation and screen-reader announcements for status and errors, then repeat the main operations while offline.
- Keep release materials consistent with the actual version, and avoid claims about file-processing speed that have not been verified.
