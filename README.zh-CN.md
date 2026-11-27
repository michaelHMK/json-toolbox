# JSON 工具箱

[English](README.md) | 简体中文

**为大 JSON 优化，所有处理都在本地完成。**

JSON 工具箱是一个以性能和隐私为核心的 Chrome 扩展（Manifest V3），提供 JSON 格式化、压缩、转义与对比。零权限、零上传、零追踪，无广告，安装后即可离线使用。

当前版本见 [`src/manifest.json`](src/manifest.json) 中的 `version` 字段。

## 面向大 JSON 的高性能

- **保持交互流畅**：Web Worker 承担解析、搜索与对比，减少主线程计算对界面响应的影响。
- **轻量浏览大结果**：树和长文本按可见区域渲染，避免一次创建全部结果节点；支持树搜索定位与完整复制。
- **大文本输入**直接在扩展自带的 CodeMirror 6 编辑器中打开。导入文件、粘贴或拖入文本后，如果输入超过 262,144 个 UTF-16 码元（ASCII 文本约 256 KiB），编辑器会随滚动渲染可见部分，全文都可以修改。
- **减少重复开销**：普通文档复用解析结果和计算缓存；大文件纯文本处理按数据选择原生或直接序列化，深层嵌套自动回退到迭代处理，并释放不需要的 Worker 文档缓存。

性能验证方法与大结果的使用边界见下文[性能验证](#性能验证)。

## 隐私

- **不上传、不追踪**：扩展不发起网络请求，不加载远程代码，没有遥测、广告或追踪 SDK。
- **零额外扩展权限**：不申请网站访问或存储权限，不读取网页内容、浏览历史、Cookie 或账号信息，见 [`src/manifest.json`](src/manifest.json)。
- **不保存输入记录**：输入与结果仅在工具页及本地 Worker 的内存中处理，不主动写入浏览器存储、文件或云端；只在你执行复制时写入系统剪贴板。
- **界面偏好仅保存在本地**：`localStorage` 仅保存你选择的主题和侧边栏折叠状态，不保存输入内容，也不需要新增扩展权限。

完整的数据处理说明见[隐私政策](PRIVACY.md)；商店使用[公开托管版本](https://github.com/michaelHMK/json-toolbox/blob/main/PRIVACY.md)。

## 功能

| 页面 | 说明 |
| --- | --- |
| **JSON 格式化** | 美化（2 空格 / 4 空格 / Tab）；语法错误提示，浏览器提供位置时显示行列并跳转；树形折叠、按层级展开、key/值搜索与高亮跳转；一键复制 |
| **JSON 压缩** | 去除空白压缩为单行；提示无效 JSON，显示可用的行列位置 |
| **JSON 转义 / 去转义** | 文本与 JSON 字符串互转，一键复制 |
| **JSON 对比** | 双 JSON 结构化 diff（新增 / 删除 / 变更 / 类型变化）；数组按下标或主键配对；可忽略指定路径；树形高亮与「只看差异」；文本逐行 diff |

格式化、压缩、转义、去转义页面和对比页的两侧输入均支持通过文件选择器或拖拽导入本地 UTF-8 `.json` 文件（每个最大 50 MiB）。导入后保留原文并自动执行操作，对比页在两侧都有输入后自动对比。大文件和粘贴的大段文本都可以直接编辑、全文复制。遇到语法错误时，可跳转到浏览器提供的错误位置。

侧边栏可在各工具页之间切换，桌面端支持收起为紧凑图标轨以释放更多工作区宽度，折叠状态会在本地记住。`src/_locales/` 包含 20 个语言及地区版本：英文（`en`）、简体中文（`zh_CN`）、繁体中文（台湾 `zh_TW`、香港 `zh_HK`）、日语（`ja`）、韩语（`ko`）、德语（`de`）、法语（`fr`）、西班牙语（`es`）及拉美西语（`es_419`）、葡萄牙语（巴西 `pt_BR`、葡萄牙 `pt_PT`）、俄语（`ru`）、阿拉伯语（`ar`）、印度尼西亚语（`id`）、越南语（`vi`）、意大利语（`it`）、罗马尼亚语（`ro`）、土耳其语（`tr`）和波兰语（`pl`）。Chrome 根据浏览器界面语言选择翻译，默认语言为英文；扩展 API 不可用时，页面静态文案也以英文兜底。阿拉伯语界面从右向左排列，JSON 输入、输出和树始终从左向右显示。

侧边栏的“外观”提供**正常、护眼、暗色**三种模式，默认使用正常模式。主题选择会保存在本地，切换工具页或重新打开扩展时会恢复该选择。

## 本地加载（开发者模式）

1. 在 [Releases 页面](https://github.com/michaelHMK/json-toolbox/releases)找到所需版本，从 **Assets** 下载 `json-toolbox-<version>.zip`，解压到单独的文件夹。
2. 在 Chrome 中打开 `chrome://extensions/`，开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择解压后直接包含 `manifest.json` 的文件夹。如果已克隆仓库，则选择仓库的 `src/` 目录。
4. 点击工具栏中的扩展图标，即可打开 JSON 工具箱。

快捷键：多数页面支持 **Cmd/Ctrl + Enter** 执行当前操作，桌面端支持 **Cmd/Ctrl + B** 收起或展开侧边栏。

按 **Tab** 进入 JSON 树；**上/下方向键**在可见节点间移动，**右/左方向键**展开、折叠分支并进入子节点或返回父节点，**Home/End** 跳到首个或末个可见节点。**Enter/空格**切换分支展开状态，**Tab** 离开树。

## 项目结构

```
src/                   # 完整扩展目录，在 Chrome 中加载此目录
  manifest.json        # 扩展清单
  *.html               # 五个工具页的稳定入口
  background.js        # Service Worker：点击扩展图标时打开工具页
  pages/               # 页面交互、视图状态与渲染
    formatter.js
    compare.js
    transform.js       # 压缩、转义、去转义共用页面逻辑
  shared/              # 浏览器界面、文档/对比会话与 Worker 通信
  vendor/              # 扩展自带的 CodeMirror 编辑器及第三方许可证
  core/                # 纯算法：JSON 排版、路径、搜索、结构对比、文本对比等
  worker/
    index.js           # Web Worker 消息入口
    tasks.js           # 操作分发、搜索数据缓存与错误响应
  styles/
    app.css            # 唯一 CSS 入口，按顺序导入以下样式
    themes.css         # 主题变量
    base.css           # 全局基础规则
    layout.css         # 应用共用布局
    components/        # 导航、主题选择器、控件、编辑器、树与文本视图
    pages/             # 格式化与对比页面样式
  icons/               # 扩展图标（manifest 引用）
  _locales/            # 国际化文案
scripts/
  build_release.py     # 发布检查与白名单打包（Python 标准库）
  gen_icons.py         # 重新生成 src/icons/ 下 PNG（可选）
  store-assets/        # 商店截图与宣传图生成脚本
  vendor-codemirror/   # 编辑器的依赖锁文件和构建脚本
tests/                 # 算法与通信契约、发布文件检查
bench/                 # 格式化/搜索/对比算法基准与可选浏览器验证
package.json           # 原生 ES modules 与开发命令
STORE_LISTING.md       # Chrome 商店上架文案与表单说明
PRIVACY.md             # 中英文隐私政策（由当前公开仓库托管）
store-assets/          # 商店截图、宣传图与上架文案（不打进扩展 ZIP）
dist/                  # 生成的扩展 ZIP 与校验文件，已加入 Git 忽略规则
```

扩展运行时文件统一放在 `src/`，开发工具与商店材料留在外面。页面业务使用浏览器原生 ES modules，无需安装依赖或构建即可加载扩展。每个 HTML 保留单一页面业务入口，另有主题引导脚本在首次绘制前恢复已保存的外观。导航生成后统一应用翻译。

各页面统一加载 `styles/app.css`，其中只按顺序声明 CSS 导入。共享组件规则放在 `styles/components/`，页面特有规则放在 `styles/pages/`，主题变量集中在 `styles/themes.css`。树组件统一管理基础树样式、虚拟行与键盘焦点样式。

| 边界 | 职责与约定 |
| --- | --- |
| `pages → shared` | 页面管理交互和视图状态；共享层负责浏览器交互与虚拟渲染。格式化树和对比树保留各自的展开、搜索导航及差异展示逻辑。 |
| `pages → document-session / comparison-session` | 格式化与对比页通过各自会话请求文档操作。会话管理 Worker 快照、取消与恢复，并丢弃过期响应；页面不直接处理快照 id，也不自行重建已丢失的 Worker 数据。 |
| `pages/shared → core` | 视图使用 JSON Pointer 与文本行偏移索引；JSON 解析、搜索与对比通过 Worker 执行。 |
| `shared/worker-client → worker/index` | 通信层按 id 配对请求、管理串行队列并报告忙碌与重置事件。同类未发送任务只保留最新输入，被丢弃的请求带 `cancelled: true`。文档生命周期与恢复由会话管理。 |
| `worker/tasks → core` | 每个 Worker 独立缓存文档与最近一次对比。会话通过 `retainSnapshot`/`snapshotId` 复用解析结果；解析后的对象图与树模型统一留在 Worker，仅向页面返回最多 256 行的有界窗口。清空使快照失效，压缩页和大文件纯文本格式化不保留不需要的搜索或快照数据。 |
| `core` | 不依赖 DOM、Chrome API 或 Worker 全局对象；无效输入抛出异常，由任务层转换为错误响应。数字原文字面量的扫描与恢复集中在 `json.js`。 |

共享虚拟视图负责窗口索引和 DOM 生命周期；页面保留各自的搜索、配对、筛选和导航逻辑。新增任务时，先将算法放入 `src/core/`，再接入 `src/worker/tasks.js`；新增运行时文件还需加入 `scripts/build_release.py` 的白名单。

## 开发验证

以下命令均从仓库根目录运行。需要 Node.js 20+ 和 Python 3，无需 `npm install`：

```bash
npm test
python3 scripts/build_release.py --check
```

测试覆盖数字字面量与特殊 key、搜索缓存与结果上限、结构及文本对比、Worker 并发和故障响应，以及发布包的间接模块和样式依赖。浏览器交互仍需按下文的功能清单验证。

测试职责划分与维护约定见 [AGENTS.md](AGENTS.md#测试维护)。新增测试前先扩展已有行为覆盖；算法边界集中在算法测试，集成测试聚焦各自的接线与交互风险。

### 性能验证

运行 `npm run bench` 测量确定性数据集下的格式化、压缩、搜索与对比性能。比较结果时，应在相同环境下串行运行基准。`npm run bench:budget` 使用 25 MiB 数据集、取三次测量的中位数，要求格式化/压缩耗时不超过原生 parse/stringify 的 3 倍；CI 会运行此检查。

格式化基准的每项操作在独立进程中运行。峰值 RSS 包含进程基线、样本生成和 V8 内存，不能视为应用保留内存，也不能据此推算整个页面的内存与输入大小之比。

可选的浏览器验证覆盖大文本、虚拟树、导航和 Worker 数据传输，需要本地已有 Playwright 与 Chromium：

```bash
# 若本地可直接 import playwright，则无需设置此变量。
export PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs
# 可选：export CHROMIUM_EXECUTABLE=/path/to/chromium
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
node bench/native-paste.mjs .
node bench/theme.mjs
```

浏览器验证命令中的 `.` 等目录参数指向仓库，脚本会加载其中的 `src/` 扩展目录，也兼容旧版本将扩展放在仓库根目录的布局；还可以直接传入扩展目录。

运行 `node bench/browser.mjs --large-edit`，可用自动生成的 10 MiB 单行 JSON 文件在五个工具页验证大文本编辑。要复现自己的样本，运行 `node bench/browser.mjs --large-edit path/to/large.min.json`，传入超过大输入阈值、没有换行的有效 UTF-8 JSON 文件。报告从文件输入的 change 事件开始计时，包含读取、解码及浏览器首次有机会绘制编辑器的耗时，并单独记录按键响应时间。脚本还检查能否复制全文，并核对各工具处理编辑后文本的结果。

CI 还会校验发布 ZIP 的摘要，解包加载扩展，启动后台 Worker，并在五个工具页各执行一次操作。本地复验可使用 Playwright 配套的完整版 Chromium，或将 `CHROMIUM_EXECUTABLE` 指向 Chromium 或 Chrome for Testing。将刚构建的 ZIP 传给脚本。

```bash
npm run build:release
version=$(node -p "require('./src/manifest.json').version")
node bench/release-smoke.mjs "dist/json-toolbox-${version}.zip"
```

这些检查覆盖大文件导入、虚拟输入、大文本与树、导航、复制、焦点、视图切换、状态恢复及深层 Worker 数据传输。`performance.mjs` 使用本地 HTTP 页面和真实 Worker；计时不包含扩展安装、启动和系统剪贴板获取。paste/drop 事件通过合成方式触发，用于测量应用的事件处理路径。

`native-paste.mjs` 使用 Chromium 剪贴板和真实粘贴快捷键，检查转义、去转义页面粘贴大文本后的直接编辑、选区替换和全文复制。默认输入约 20 MiB，可用 `BENCH_PASTE_MIB` 调整；计时从 paste 事件开始，到两次动画帧后结束，样本构造和剪贴板写入不计时。设置 `BENCH_SCREENSHOT_DIR` 可保存页面截图；用 `BENCH_VERIFY=0` 加旧版本目录可记录基线。它每页测量一次，比较耗时时应在同一环境串行运行。

`TREE_TOGGLE_BUDGET_MS`、`PERF_INPUT_BUDGET_MS`、`PERF_FRAME_BUDGET_MS` 分别调整同步树开合 p50、输入处理及布局、滚动帧间隔 p95 的预算，默认值为 16、50、35 ms。`remote-state.mjs` 的密集差异检查对滚动阶段执行耗时预算断言，首次对比和 Worker 恢复单独记录。

可访问性检查通过模拟扩展国际化 API 加载英文和阿拉伯语翻译，验证布局、键盘导航及 Chromium 无障碍树；它不能代替真实读屏软件测试。

文件导入基准默认在两个页面对每个场景各跑三次，输出逐次测量及中位数。默认场景包括 50 MiB 常规文档（`regular`）、4 MiB 保留 `1.20` 字面量的数组（`decimals`）、50 MiB 无效单行 JSON（`invalid`）。样本及 `File` 构造在计时前完成；总耗时包含成功或错误反馈后的两次动画帧，长任务仅统计导入测量区间。完整输入/输出复制及错误位置检查在测量后执行。堆内存读数包含基准样本；耗时较长的跨代理内存测量需用 `BENCH_MEMORY=1` 显式开启。

```bash
# 选择场景、操作、大小和重复次数。
BENCH_SCENARIOS=regular,decimals,invalid BENCH_REPEATS=3 node bench/file-import.mjs .
BENCH_SCENARIOS=decimals BENCH_ACTIONS=minify BENCH_DECIMAL_MIB=4 node bench/file-import.mjs .
# 可选深层场景：10,000 层数组，前导空格使输入超过大文件阈值。
# 格式化结果约 191 MiB，建议单独执行。
BENCH_SCENARIOS=deep BENCH_DEEP_DEPTH=10000 BENCH_REPEATS=1 node bench/file-import.mjs .
# 使用同一脚本测旧版本目录，记录旧行为及校验失败而不中止。
BENCH_VERIFY=0 node bench/file-import.mjs /path/to/baseline-checkout
```

`BENCH_FILE_MIB` 调整常规和无效文件的大小，默认 `50`。`BENCH_VERIFY=0` 仍会记录正确性检查失败。可选的 `BENCH_MAX_MS` 和 `BENCH_MAX_LONG_TASK_MS` 分别约束总耗时中位数与最长任务中位数；考虑硬件与浏览器差异，默认不设耗时预算。比较基线和修改后版本时，请使用相同配置串行运行。

大文本编辑器和大结果视图均使用虚拟渲染。浏览器原生查找在这些视图中仅覆盖已渲染部分。需要查找其他内容时，可使用树搜索或复制完整文本。完整输入和结果文本仍由页面保存在内存中，解析对象图和树索引统一保留在 Worker。较大的文本差异采用整块替换展示。

日常使用优先按上文加载扩展。仅预览页面时可运行 `python3 -m http.server 8000 --directory src`，访问 `http://localhost:8000/formatter.html`；原生模块不支持直接双击 HTML 的 `file://` 方式，HTTP 预览也不提供 Chrome 扩展国际化 API。

## 重新构建内置编辑器

扩展随附可读的 CodeMirror 6 ES module。日常开发、测试、打包和加载扩展都直接使用仓库中的文件。需要重新生成编辑器时，从仓库根目录运行以下命令。

```bash
npm ci --prefix scripts/vendor-codemirror --include=dev --ignore-scripts
npm run build --prefix scripts/vendor-codemirror
```

锁文件固定了所有依赖和 esbuild 的版本。构建脚本先将 `scripts/vendor-codemirror/long-line-scroll.patch` 应用到 `@codemirror/view`，再生成 `src/vendor/codemirror.js` 及配套的许可证文件。更新编辑器依赖时，请复核补丁，并一起提交锁文件和这两份产物。[依赖包版本与许可证](src/vendor/codemirror.LICENSE.txt)

## 重新生成图标

需要 Python 3，无第三方依赖：

```bash
python3 scripts/gen_icons.py
```

输出目录为 `src/icons/`（会覆盖现有 PNG）。

## 打包发布

发布新版本时，先更新 `src/manifest.json` 中的 `version` 并提交。在仓库的 **Releases** 页面创建 Release，选择指向该提交的标签，点击 **Publish release**。GitHub Actions 会打包该标签对应的扩展，并将 `json-toolbox-<version>.zip` 和对应的 `.zip.sha256` 校验文件上传到该 Release 的 **Assets**。文件名中的版本号取自 `manifest.json`。

本地打包可使用 Python 3 运行以下命令。

```bash
python3 scripts/build_release.py --check
python3 scripts/build_release.py
```

脚本检查版本号、所有语言版本的名称和简介长度、翻译键、图标尺寸、HTML 资源引用，以及 JavaScript 静态导入、Worker 入口和 CSS `@import`/`url()` 依赖的相对路径，再按白名单打包 `src/` 中的运行时文件。输出为 `dist/json-toolbox-<version>.zip` 和对应的 `.zip.sha256` 校验文件。`manifest.json` 位于 ZIP 根目录，没有外层 `src/` 目录；测试、文档、截图、开发配置和 `.git` 不会被收录。`dist/` 已加入 Git 忽略规则。

上传到 Chrome 应用商店前，将 ZIP 解压到一个新目录，在 `chrome://extensions/` 中加载该目录并完成下面的检查。

### 首次上架

1. 在 [Chrome Web Store 开发者控制台](https://chrome.google.com/webstore/devconsole/)注册账号，阅读并接受协议，支付页面显示的一次性注册费。参见[注册说明](https://developer.chrome.com/docs/webstore/register)。
2. 填写发布者名称并验证联系邮箱，按控制台提示完成账号信息。为 Google 账号启用两步验证；这是发布前的[官方要求](https://developer.chrome.com/docs/webstore/program-policies/two-step-verification)。
3. 隐私政策由当前公开仓库托管：填写 [公开隐私政策网址](https://github.com/michaelHMK/json-toolbox/blob/main/PRIVACY.md)。修改本地 [PRIVACY.md](PRIVACY.md) 后，通过 PR 合并到 `main` 分支即可更新公开版本；上传商店前用未登录窗口确认链接可访问。
4. 新建商店条目，上传 `dist/` 下的扩展 ZIP，按 [STORE_LISTING.md](STORE_LISTING.md) 填写中英文描述、隐私表单和测试说明，并上传 `store-assets/` 下对应语言的图片。
5. 选择分发地区和公开可见性，检查预览后提交审核。可选择审核通过后自动发布或自行发布，参见[官方发布流程](https://developer.chrome.com/docs/webstore/publish)。

### 上传前功能检查

- 点击扩展图标打开工具页；在扩展管理页确认没有加载错误。
- 检查格式化的三种缩进、无效 JSON 定位、树形展开、搜索、复制与清空。
- 检查压缩、转义和去转义，包括换行、引号、反斜杠和 Unicode 文本。
- 检查 JSON 对比的新增、删除、值及类型变化，数组主键配对、忽略路径、只看差异与文本对比。
- 检查中文、英文和阿拉伯语文案，包括从右到左的界面布局、从左到右的代码区域及本地化可访问名称。检查树的键盘导航和状态、错误的读屏播报，断网后重复主要操作。
- 发布材料与实际版本保持一致，不承诺未经验证的文件处理速度。
