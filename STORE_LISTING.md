# JSON 工具箱 — Chrome Web Store 上架信息

> 本文件仅供上架时复制粘贴使用，不要打进 zip 包。

## 中文（简体）

**名称**：JSON 工具箱

**简短描述**（132 字符以内）：
高性能 JSON 工具箱：格式化、压缩、转义与去转义、树形搜索、结构与文本对比。数据仅在本地处理，无广告、无追踪、不收集数据。

**详细描述**：

JSON 工具箱是一个以性能和隐私为核心的 JSON 工具箱。点击扩展图标即可在独立标签页中格式化、查看和比较 JSON，完全离线运行，无需登录或申请额外权限。通过 Web Worker、树与文本的虚拟显示以及解析结果复用，减少处理大 JSON 时的界面阻塞与重复开销；实际速度取决于设备和数据结构。

格式化页功能：
- 格式化 / 美化，支持 2 空格、4 空格、Tab 缩进
- 提示语法错误，显示行列号并定位；浏览器未提供位置时由本地校验补充
- 树形折叠视图：虚拟滚动、按层级展开、key/值搜索高亮并逐条跳转
- 一键复制结果

本地文件导入：
- 五个工具页均可通过文件选择器导入文件，也可将文件拖放到输入区
- 每次导入一个 UTF-8 编码的 `.json` 文件，最大 50 MiB。导入后自动执行当前操作，对比页在两侧都有输入时开始对比
- 导入大文件、粘贴或拖入大段文本后，编辑器自动打开全文，可直接修改和复制

压缩、转义与去转义页面：
- 每个功能使用独立页面，通过统一侧边导航切换
- 压缩（minify）并提示无效 JSON，显示可用的行列信息
- JSON 字符串转义与去转义互转，一键复制结果

对比页功能：
- 两个 JSON 的结构化对比：按路径展示新增 / 删除 / 值变化 / 类型变化
- 数组支持按下标对比或按主键（如 id）配对
- 可忽略指定路径（如时间戳字段）
- 完整树高亮差异 / 只看差异模式，逐处差异导航
- 文本行级 diff 视图

外观：
- 在侧边栏查看缩略预览，选择正常、护眼或暗色模式；默认为正常模式
- 主题选择仅保存在本地，切换工具页或重新打开后恢复，不保存输入和结果

隐私：所有处理在浏览器本地完成，不收集或上传数据，不发起网络请求，不加载远程代码，无广告或追踪。不保存输入历史。执行复制时，扩展会将选中的文本、输入内容或处理结果写入系统剪贴板。粘贴时只处理你粘贴的文本。

大文本编辑器和大结果视图都会随滚动渲染可见内容。浏览器原生查找仅覆盖已渲染部分。需要查找其他内容时，可使用树搜索或复制完整结果。输入与结果仍完整保留在内存中。差异较多时，未匹配的文本区间可能按整块展示。

## English

**Name**: JSON Toolbox

**Short description** (max 132 chars):
High-performance JSON Toolbox: format, minify, escape and compare locally. No ads, tracking or data collection.

**Detailed description**:

JSON Toolbox puts performance and privacy first. Click the extension icon to format, browse and compare JSON in a dedicated tab. It works fully offline, with no account or extra permissions required. Web Workers, virtual tree and text views, and reused parsing results reduce interface blocking and repeated work with large JSON; performance depends on your device and data structure.

Formatter page:
- Beautify with 2-space / 4-space / Tab indent
- Syntax errors with line/column and navigation, including a local fallback when the browser omits the location
- Collapsible tree view: virtual scrolling, expand-to-level, key/value search with match navigation
- One-click copy

Local file import:
- On any of the five tool pages, choose a file or drop it into an input pane
- Import one UTF-8 `.json` file at a time, up to 50 MiB each. The tool runs automatically after import. Compare runs when both inputs contain text
- Import a large file or paste or drop a large block of text to open it directly in the editor. You can edit and copy the entire input

Minify, escape and unescape pages:
- A separate page for each tool, connected by consistent sidebar navigation
- Minify JSON and report invalid input, including error locations when available
- Escape and unescape JSON string content, with one-click copy

Compare page:
- Structural diff between two JSONs: added / removed / changed / type-changed by path
- Arrays compared by index or matched by a key field (e.g. id)
- Optional ignore paths (e.g. timestamp fields)
- Full tree with highlighted diffs, or diffs-only mode, with per-diff navigation
- Line-level text diff view

Appearance:
- Choose Normal, Eye comfort or Dark from the sidebar, with thumbnail previews; Normal is the default
- Only the theme choice is saved locally and restored across tools and after reopening; input and results are not saved

Privacy: all processing stays in your browser. No data collection or uploads, network requests, remote code, ads or tracking. Input history is not saved. When you copy, the extension writes the selected text, input or result to the system clipboard. When you paste, it processes only the text you provide.

The editor for large inputs and the large result views render text as you scroll. Native browser Find covers only the rendered portion in these views. Tree search and copying complete results remain available. Complete inputs and results stay in memory. For extensive text differences, unmatched sections may be shown as whole blocks.

## 上架表单

名称和简短描述来自发布包的 `_locales/*/messages.json`；上方文案与发布包一致。默认语言为 English，名称为 **JSON Toolbox**；简体中文名称为 **JSON 工具箱**。

每种语言的可复制文案位于下方索引中的 `listing.txt`，依次包含名称、简短描述和详细描述。名称与简短描述应与仓库中该语言的 `src/_locales/<locale>/messages.json` 保持完全一致；详细描述填入控制台对应语言的详情字段。README 继续仅维护中英双语。

| 字段 | 填写内容 |
| --- | --- |
| 类别 | 选择控制台实际提供的 Developer Tools；若在 Productivity 下分组，选择对应的开发工具分类 |
| 单一用途 | 在浏览器本地查看和处理用户主动输入的 JSON，包括格式化、压缩、字符串转义及差异对比。 |
| Single purpose | View and process user-provided JSON locally in the browser, including formatting, minification, string escaping and comparison. |
| 权限理由 | 当前 manifest 未声明权限或主机访问权限；如果没有显示此字段，无需填写。打开工具标签页不需要 tabs 权限。 |
| 远程代码 | 选择 No, I am not using remote code。所有 JavaScript 和 Worker 均包含在扩展包中。 |
| 数据使用 | 不勾选收集数据的类别；核对并确认数据不出售、不用于无关用途、不用于信用或贷款评估的声明。 |
| 隐私政策 | 填写 https://github.com/michaelHMK/json-toolbox/blob/main/PRIVACY.md ，由当前公开项目仓库托管。修改本地政策后通过 PR 合并到 main 分支即可更新。 |
| 网站、支持链接 | 可选；仅填写已经公开可访问、由你维护的项目或支持页面。 |
| 分发 | 当前版本无付费功能。选择需要覆盖的地区；公开可见性用于正式上架。 |

这些隐私填法对应当前版本的实际行为：仅在本地保存主题偏好，不保存输入或结果，也不上传或云同步该偏好。后续改变数据处理方式时需重新核对。[官方隐私表单说明](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)。

## 图片材料

- 商店图标：[src/icons/icon128.png](src/icons/icon128.png)，128×128 PNG，图案 96×96，四周 16px 透明留白。
- 每种语言的目录包含 5 张 1280×800 实际界面截图、2 张本地化宣传图及一份 `listing.txt`。
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
| `01-formatter-tree.png` | 正常模式：JSON 格式化与树形浏览 | 1280×800 |
| `02-compare-structure.png` | 正常模式：JSON 结构对比 | 1280×800 |
| `03-compare-text.png` | 暗色模式：JSON 逐行文本对比 | 1280×800 |
| `04-minify-import.png` | 护眼模式：文件导入与压缩结果 | 1280×800 |
| `05-theme-picker.png` | 正常模式：外观弹窗与三种主题预览 | 1280×800 |
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

No account, credentials or network connection are needed.

1. Install the extension, then click its toolbar icon to open the JSON Toolbox tab.
2. On JSON Formatter, click Sample and then Format. Switch to Tree to expand nodes and search keys or values.
3. Open JSON Minify, JSON Escape and JSON Unescape from the sidebar. Each page has a Sample button and an action button to produce a local result. Click Copy to copy the result, or select some input text and use the copy shortcut.
4. On any of the five tool pages, use Import file or drop one UTF-8 `.json` file of up to 50 MiB into an input pane. Processing starts automatically after import. On Compare, fill both inputs to start the comparison. A large file opens directly in the editor. Type at the start or end, then select all and copy to check the edited input. You can also paste or drop a large block of text into the input pane.
5. Open JSON Compare and click Sample, then Compare. Inspect the structural differences and switch to the text comparison view. Array key matching and ignored paths are optional controls.
6. Open Appearance in the sidebar. Check the three thumbnail previews, select Eye comfort or Dark, then switch tools or reopen the page to confirm the selection is remembered. Normal is the default before a selection is saved. Press Escape or click outside to close the picker.
7. All operations run locally. Only the theme preference is saved locally; input and results are not saved. No host permissions, remote code, analytics or user-data uploads are used.
