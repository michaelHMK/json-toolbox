# JSON 工具箱 — Chrome Web Store 上架信息

> 本文件仅供上架时复制粘贴使用，不要打进 zip 包。

## 中文（简体）

**名称**：JSON 工具箱 - 格式化、树形查看、对比与 YAML 转换

**简短描述**（132 字符以内）：
本地 JSON/JSONC/JSON5 格式化、树形查看、Diff 对比与 YAML 互转，支持 50 MiB 大文件及网页 JSON 格式化。无广告无追踪。

**详细描述**：

JSON 工具箱是一款高速本地 JSON 格式化、JSON 查看、JSON 对比与 YAML 转换扩展，兼容 JSONC / JSON5，并可在独立标签页与网页中离线运行。默认安装零网站权限、零权限弹窗警告、无需登录。

格式化、树形查看与 JSONC / JSON5：
- 美化 JSON，支持 2 空格、4 空格或 Tab 缩进，完整保留大整数与小数精度
- 严格 JSON 解析不通过时自动回退到 JSONC / JSON5 宽松解析，支持行/块注释、末尾逗号、单引号字符串、无引号键名和十六进制整数
- 提示语法错误并显示行列号及一键定位；浏览器未提供位置时由本地校验补充
- 树形折叠视图：虚拟滚动、按层级展开、key/值搜索高亮并逐条跳转、一键复制全文

JSON <-> YAML 双向转换：
- 在独立工具页中支持 JSON 转 YAML 1.2 与 YAML 转 JSON，支持多文档 YAML 转 JSON 数组、循环与过量别名防护，并保留数值字面精度
- 一键互换转换方向，本地高速完成转换与复制

网页 JSON 自动格式化与右键菜单：
- 选中任意网页文本后右键“在 JSON 工具箱中打开选中内容”，即可直接载入并格式化（多行 JS/JSON 选区亦可保留换行导入）
- 随时对当前标签页右键点击“格式化此页 JSON”，仅通过 `activeTab` 临时读取当页并渲染交互式树视图
- 侧边栏“自动格式化网页中的 JSON”开关默认关闭，不访问任何网页；仅在你主动开启时请求可选站点权限，查看器支持 原文 / 格式化 切换、复制、“在工具箱中打开”以及可选的 `text/plain` 纯文本页面开关

导入本地文件：
- 七个工具页面均支持选择文件或拖放导入（JSON 与对比页支持 `.json`，YAML 转 JSON 支持 `.yaml` / `.yml`）
- 每次导入一个 UTF-8 编码文件，最大 50 MiB，导入后自动开始处理；对比页面会在两侧均有内容时自动对比
- 导入大文件、粘贴或拖放超长文本时直接在编辑器中打开，可编辑并复制全文

压缩、转义与去转义：
- 通过侧边栏快速切换各个工具页
- 去除多余空白压缩为单行 JSON（同样兼容 JSONC / JSON5 宽松输入）
- JSON 字符串转义与去转义互转，一键复制结果

JSON 对比：
- 按路径显示结构差异：新增 / 删除 / 值变更 / 类型变化
- 支持数组按索引对比或按 `id` 等键字段配对，可忽略时间戳等路径
- 完整树高亮差异 / 只看差异模式，逐处差异导航，以及格式化后的逐行文本 Diff

外观：
- 在侧边栏通过缩略图切换正常、护眼或暗色模式（默认正常模式），网页内嵌查看器同步跟随主题
- 本地仅保存主题选择、侧边栏折叠状态及可选“同时格式化纯文本页面”开关状态，不存储任何输入或输出内容

隐私：所有处理均在本地浏览器内存中完成，不收集或上传数据，无网络请求、无远程代码、无广告与追踪。默认不申请网站读取权限；右键操作仅在点击当次触发，自动格式化仅在你主动开启后在内存中处理内容类型为 JSON 的页面，不会保存网页内容。

完整输入与结果仍保留在内存中，实际性能取决于设备和数据结构。虚拟视图每次仅渲染部分内容，浏览器原生查找只覆盖已渲染部分；需要时可使用树搜索或复制完整结果。差异较多时，未匹配的文本区间可能按整块展示。

## English

**Name**: JSON Toolbox - Formatter, Viewer, Diff & YAML

**Short description** (max 132 chars):
Local JSON & JSON5 formatter, viewer, diff, and YAML converter. Handles 50 MiB files & API pages offline with zero tracking.

**Detailed description**:

JSON Toolbox is a fast offline JSON formatter, JSON viewer, JSON diff, and JSON to YAML converter with JSONC and JSON5 support in a dedicated browser tab. No website access is requested on install, with zero permission warnings and no account required.

Format, browse and JSONC / JSON5:
- Beautify JSON with 2-space, 4-space or Tab indentation, keeping large integers and decimal precision intact
- Automatically falls back from strict JSON to lenient JSONC / JSON5 parsing when input includes comments, trailing commas, single-quoted strings, unquoted keys or hex integers
- See syntax errors with line/column details and jump to the error location, including a local fallback when the browser omits the position
- Collapsible tree view: virtual scrolling, expand-to-level, key/value search with match navigation and one-click copy

JSON <-> YAML conversion:
- Convert JSON to YAML 1.2 (clean quoting, multiline block scalars and preserved number precision) or YAML back to JSON in dedicated two-way views
- Parse multi-document YAML streams into a JSON array while protecting against circular or oversized aliases, and swap conversion direction cleanly

Webpage JSON, auto-format and right-click menu:
- Select text on any webpage, right-click "Open selection in JSON Toolbox", and format snippets cleanly in one click (multiline JS/JSON selections fallback cleanly)
- Use the page right-click menu "Format JSON on this page" on demand via `activeTab` without granting persistent site permissions
- Optional "Auto-format JSON pages" switch in the sidebar is OFF by default and requests optional host access only when turned on, with Raw / Formatted view toggle, Copy, "Open in JSON Toolbox" and an optional `text/plain` sub-option

Import local files:
- Across all seven tool pages, choose a file or drag and drop into an input pane
- Import UTF-8 files up to 50 MiB at a time (`.json` across JSON/Compare tools; `.yaml` / `.yml` on YAML -> JSON). Processing starts automatically after import
- Large files or pasted/dropped long text open directly in the editor where you can inspect, edit and copy the full content

Minify, escape and unescape:
- Switch between dedicated tools from the sidebar
- Strip extra whitespace for compact single-line JSON output (also supporting lenient JSONC/JSON5 fallback)
- Escape and unescape JSON string content, with one-click copy

Compare JSON:
- Structural diff between two JSONs: added / removed / changed / type-changed by path
- Compare arrays by index or match elements by a key field (e.g. `id`), ignore selected paths, filter diffs-only, navigate changes or switch to line-level text diff

Appearance:
- Choose Normal, Eye comfort or Dark from the sidebar, with thumbnail previews (Normal is default), shared across pages including the embedded page viewer
- Only theme preference, sidebar state and the optional `text/plain` auto-format toggle are saved locally; inputs and results are never saved

Privacy: All processing happens locally in your browser with no data collection, uploads, network requests, remote code, ads or tracking. Zero website permissions are requested by default. Right-click actions run only on the active tab when clicked, and optional auto-format reads pages whose content is JSON only while enabled in memory without storing page content.

Large inputs and results remain in memory; performance depends on your device and data structure. Virtual views render only part of the content at a time, so native browser Find covers only the rendered portion. Use tree search or copy the complete result when needed. For extensive text differences, unmatched sections may be shown as whole blocks.

## 上架表单

名称和简短描述来自发布包的 `_locales/*/messages.json`；上方文案与发布包一致。默认语言为 English，名称为 **JSON Toolbox - Formatter, Viewer, Diff & YAML**（菜单短名称 `JSON Toolbox`）；简体中文名称为 **JSON 工具箱 - 格式化、树形查看、对比与 YAML 转换**。

每种语言的可复制文案位于下方索引中的 `listing.txt`，依次包含名称、简短描述和详细描述。名称与简短描述应与仓库中该语言的 `src/_locales/<locale>/messages.json` 保持完全一致；详细描述填入控制台对应语言的详情字段。README 继续仅维护中英双语。

| 字段 | 填写内容 |
| --- | --- |
| 类别 | 选择控制台实际提供的 Developer Tools；若在 Productivity 下分组，选择对应的开发工具分类 |
| 单一用途 | 在浏览器本地格式化、查看、转换（JSONC/JSON5、JSON ↔ YAML）与对比 JSON，并按需或在用户主动开启后本地格式化网页 JSON 响应。 |
| Single purpose | Format, view, convert (JSONC/JSON5, JSON <-> YAML), and compare JSON locally in the browser, plus format JSON responses in web pages on user action or opt-in. |
| 权限理由（`contextMenus`） | 注册两个按需右键菜单项：“在 JSON 工具箱中打开选中内容”（选中文本时）和“格式化此页 JSON”（页面上下文）。 |
| 权限理由（`activeTab`） | 仅在用户点击右键菜单时临时授予当前激活标签页的读取权限，不要求在安装时申请常驻网站访问权限。 |
| 权限理由（`scripting`） | 用于（1）用户点击右键选区菜单时在当前页精确读取选中内容，或点击“格式化此页 JSON”时注入轻量检测脚本；（2）用户在设置中主动开启“自动格式化网页中的 JSON”后，动态注册或注销 `document_start` 检测脚本。 |
| 权限理由（`storage`） | 使用内存存储 `chrome.storage.session` 传递一次性的右键选区 / 网页 JSON 打开令牌（读取后立即删除，上限 10 MB）；使用本机 `chrome.storage.local` 仅保存可选的“同时格式化纯文本页面”布尔开关状态（默认关闭）。 |
| 权限理由（可选主机权限） | `optional_host_permissions`（`http://*/*`、`https://*/*`、`file:///*`）默认不授予，安装无警告。仅在用户主动打开侧边栏“自动格式化网页中的 JSON”开关时触发浏览器授权弹窗，用于在本地内存中检测并嵌入式格式化 JSON 响应页面；关闭开关或撤销权限后立即停止。 |
| 远程代码 | 选择 No, I am not using remote code。所有 JavaScript、Worker 与 vendored 编辑器/YAML 解析器均已打包在扩展包中（无 `eval` 或远程脚本加载）。 |
| 数据使用 | 不勾选收集数据的类别；在隐私声明中说明仅在用户触发右键菜单或主动开启可选自动格式化时于本地内存读取当前页面/选中文本中的 JSON，不上传、不存储、不出售，不用于跟踪或信用评估。 |
| 隐私政策 | 填写 https://github.com/michaelHMK/json-toolbox/blob/main/PRIVACY.md ，由当前公开项目仓库托管。修改本地政策后通过 PR 合并到 main 分支即可更新。 |
| 网站、支持链接 | 可选；仅填写已经公开可访问、由你维护的项目或支持页面。 |
| 分发 | 当前版本无付费功能。选择需要覆盖的地区；公开可见性用于正式上架。 |

这些隐私填法对应当前版本的实际行为：本机仅保存界面偏好（主题、`localStorage` 中的侧边栏折叠状态，以及 `chrome.storage.local` 中的纯文本自动格式化开关），不持久化输入、网页内容或结果，也不上传或云同步。[官方隐私表单说明](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)。

## 图片材料

- 商店图标：[src/icons/icon128.png](src/icons/icon128.png)，128×128 PNG，图案 96×96，四周 16px 透明留白。
- 每种语言的目录包含 5 张 1280×800 实际界面加顶部本地化标语截图、2 张本地化宣传图及一份 `listing.txt`。
- 截图顶部标语保存在 [scripts/store-assets/captions.json](scripts/store-assets/captions.json)（独立于 `src/_locales/`，避免触发翻译键未使用门禁），20 国关键词映射与母语复核清单保存在 [store-assets/keywords.md](store-assets/keywords.md)。
- 截图覆盖正常、护眼和暗色三种模式，以及当前带缩略预览的外观选择弹窗；正常仍是首次打开的默认模式。
- 宣传图同时突出高性能、隐私和本地处理；大图强调针对大 JSON 的优化，不承诺具体耗时或性能排名。
- 截图展示真实功能，不添加无法验证的速度或排名承诺。尺寸依据[官方图片规范](https://developer.chrome.com/docs/webstore/images)。

| 语言 | 目录 | 上架文案及用途 |
| --- | --- | --- |
| English | [store-assets/en/](store-assets/en/) | [listing.txt](store-assets/en/listing.txt)：默认英文详情页 |
| 简体中文 | [store-assets/zh_CN/](store-assets/zh_CN/) | [listing.txt](store-assets/zh_CN/listing.txt)：简体中文详情页 |
| Français | [store-assets/fr/](store-assets/fr/) | [listing.txt](store-assets/fr/listing.txt)：法语详情页 |
| Deutsch | [store-assets/de/](store-assets/de/) | [listing.txt](store-assets/de/listing.txt)：德语详情页 |
| 日本語 | [store-assets/ja/](store-assets/ja/) | [listing.txt](store-assets/ja/listing.txt)：日语详情页 |
| 한국어 | [store-assets/ko/](store-assets/ko/) | [listing.txt](store-assets/ko/listing.txt)：韩语详情页 |
| Español | [store-assets/es/](store-assets/es/) | [listing.txt](store-assets/es/listing.txt)：西班牙语详情页 |
| Español (Latinoamérica) | [store-assets/es_419/](store-assets/es_419/) | [listing.txt](store-assets/es_419/listing.txt)：拉美西语详情页，适用于墨西哥等拉美地区 |
| Bahasa Indonesia | [store-assets/id/](store-assets/id/) | [listing.txt](store-assets/id/listing.txt)：印度尼西亚语详情页 |
| Tiếng Việt | [store-assets/vi/](store-assets/vi/) | [listing.txt](store-assets/vi/listing.txt)：越南语详情页 |
| Italiano | [store-assets/it/](store-assets/it/) | [listing.txt](store-assets/it/listing.txt)：意大利语详情页 |
| Română | [store-assets/ro/](store-assets/ro/) | [listing.txt](store-assets/ro/listing.txt)：罗马尼亚语详情页 |
| Türkçe | [store-assets/tr/](store-assets/tr/) | [listing.txt](store-assets/tr/listing.txt)：土耳其语详情页 |
| Polski | [store-assets/pl/](store-assets/pl/) | [listing.txt](store-assets/pl/listing.txt)：波兰语详情页 |
| Português (Brasil) | [store-assets/pt_BR/](store-assets/pt_BR/) | [listing.txt](store-assets/pt_BR/listing.txt)：巴西葡萄牙语详情页 |
| Português (Portugal) | [store-assets/pt_PT/](store-assets/pt_PT/) | [listing.txt](store-assets/pt_PT/listing.txt)：葡萄牙葡萄牙语详情页 |
| Русский | [store-assets/ru/](store-assets/ru/) | [listing.txt](store-assets/ru/listing.txt)：俄语详情页 |
| العربية | [store-assets/ar/](store-assets/ar/) | [listing.txt](store-assets/ar/listing.txt)：阿拉伯语详情页 |
| 繁體中文（台灣） | [store-assets/zh_TW/](store-assets/zh_TW/) | [listing.txt](store-assets/zh_TW/listing.txt)：繁体中文详情页 |
| 繁體中文（香港） | [store-assets/zh_HK/](store-assets/zh_HK/) | [listing.txt](store-assets/zh_HK/listing.txt)：香港用语文案与素材备存 |

目前[官方支持语言表](https://developer.chrome.com/docs/extensions/reference/api/i18n#locales)列出 `zh_TW`，未列出 `zh_HK`。香港用语文案和图片保留供适用渠道使用；若商店控制台没有香港选项，使用繁体中文选项及对应的 `zh_TW` 材料。

每个语言目录使用相同的文件名：

| 文件 | 用途 | 尺寸 |
| --- | --- | --- |
| `01-auto-format-api.png` | 正常模式：自动格式化 API JSON 响应与树形浏览（含浏览器地址栏与顶部标语） | 1280×800 |
| `02-compare-structure.png` | 正常模式：结构化 JSON Diff（键匹配与忽略路径） | 1280×800 |
| `03-lenient-json.png` | 护眼模式：JSONC / JSON5 注释与末尾逗号宽松解析 | 1280×800 |
| `04-json-yaml.png` | 暗色模式：保留数字精度的 JSON ↔ YAML 双向转换 | 1280×800 |
| `05-large-file-themes.png` | 正常模式：50 MiB 大文件树视图与三种主题切换器 | 1280×800 |
| `promo-440x280.png` | 小型宣传图 | 440×280 |
| `promo-1400x560.png` | 大型宣传图 | 1400×560 |
| `listing.txt` | 名称、简短描述及详细描述 | UTF-8 纯文本 |

保留根路径英文宣传图 [store-assets/promo-440x280.png](store-assets/promo-440x280.png) 和 [store-assets/promo-1400x560.png](store-assets/promo-1400x560.png)，兼容现有引用；英文详情页也可直接使用 `store-assets/en/` 内的对应文件。

修改名称或界面后，可重新生成全部图片。需要本地已有 Playwright 和支持扩展的完整 Chromium（不能使用 `chrome-headless-shell`）：

```bash
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_EXECUTABLE=/path/to/full/chromium \
node scripts/store-assets/generate.mjs
```

若 Playwright 可直接导入且已安装其完整 Chromium，可省略对应环境变量。脚本从 `src/` 加载扩展，将全部 20 个语言及地区版本的截图与宣传图写入 `store-assets/`。仅更新部分语言时，可用逗号分隔的 `STORE_LOCALES` 筛选：

```bash
STORE_LOCALES=en,zh_CN node scripts/store-assets/generate.mjs
```

仅调整宣传图时，可保留现有界面截图：

```bash
node scripts/store-assets/generate.mjs --promos-only
```

`listing.txt` 是供上架时复制的独立文案，不会随图片生成自动翻译；修改功能或 `src/_locales/` 中的名称、简介后，应同步检查对应文案。

每个导入文件的上限为 50 MiB。导入、粘贴或拖放后的输入超过 262,144 个 UTF-16 码元（`text.length > 256 * 1024`）时，会自动在大文本编辑器中打开，全文都可修改。

## 审核测试说明

No account, credentials or network connection are needed for local toolbox tools.

1. Install the extension, confirming there are zero install-time permission warnings, then click its toolbar icon to open the JSON Toolbox tab.
2. On JSON Formatter, click Sample and then Format, or paste lenient JSONC/JSON5 (e.g. comments, trailing commas, unquoted keys, `0xFF`) to verify automatic lenient fallback with status notification. Switch to Tree to expand nodes and search keys or values.
3. Open JSON Minify, JSON Escape, JSON Unescape, `JSON -> YAML` and `YAML -> JSON` from the sidebar. Each page has a Sample button, action button and copy control; test swapping direction between YAML pages.
4. Across all seven tool pages, use Import file or drop a UTF-8 file up to 50 MiB (`.json`, or `.yaml` / `.yml` on `YAML -> JSON`). Processing starts automatically after import. Large files open directly in the editor.
5. Open JSON Compare and click Sample, then Compare. Inspect structural diffs, optional array key matching (`id`), ignored paths, diffs-only filtering, and text comparison view.
6. Right-click selected JSON text on any normal webpage -> choose "Open selection in JSON Toolbox" to inspect instant handoff via `chrome.storage.session` (cleared immediately after load).
7. On an API/JSON webpage (or local test JSON page), right-click -> "Format JSON on this page" to verify on-demand rendering via `activeTab`, toggling Raw / Formatted and "Open in JSON Toolbox".
8. Optionally enable Settings -> "Auto-format JSON pages" in the sidebar to inspect the browser's optional host permission prompt and automatic formatting of JSON responses; turn it off (or revoke host access in `chrome://extensions`) to confirm auto-formatting stops immediately. Open Appearance to test Normal, Eye comfort and Dark themes across tools and the page viewer.
9. All operations run locally in memory. Only visual preferences (theme, sidebar state, and optional plain-text toggle) are stored on-device; remote code, analytics or user-data uploads are never used.
