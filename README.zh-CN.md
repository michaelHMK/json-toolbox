# JSON 工具箱

[English](README.md) | 简体中文

**为大 JSON 优化，所有处理都在本地完成。**

JSON 工具箱是一个以性能和隐私为核心的 Chrome 扩展（Manifest V3），提供 JSON 格式化、压缩、转义与对比。零权限、零上传、零追踪，无广告、无运行时第三方依赖，安装后即可离线使用。

当前版本见 [`manifest.json`](manifest.json) 中的 `version` 字段。

## 面向大 JSON 的高性能

- **保持交互流畅**：Web Worker 承担解析、搜索与对比，减少主线程计算对界面响应的影响。
- **轻量浏览大结果**：树和长文本按可见区域渲染，避免一次创建全部结果节点；支持树搜索定位与完整复制。
- **大输入虚拟化**：超过 2 MiB 的输入使用只读虚拟预览，避免原生 textarea 的全量布局开销。
- **减少重复开销**：普通文档复用解析结果和计算缓存；大文件纯文本处理按数据选择原生或直接序列化，深层嵌套自动回退到迭代处理，并释放不需要的 Worker 文档缓存。

性能验证方法与大结果的使用边界见下文[性能验证](#性能验证)。

## 隐私

- **不上传、不追踪**：扩展不发起网络请求，不加载远程代码，没有遥测、广告或第三方 SDK。
- **零额外扩展权限**：不申请网站访问或存储权限，不读取网页内容、浏览历史、Cookie 或账号信息，见 [`manifest.json`](manifest.json)。
- **不保存输入记录**：输入与结果仅在工具页及本地 Worker 的内存中处理，不主动写入浏览器存储、文件或云端；只在你执行复制时写入系统剪贴板。

完整的数据处理说明见[隐私政策](PRIVACY.md)；商店使用[公开托管版本](https://github.com/michaelHMK/json-toolbox/blob/main/PRIVACY.md)。

## 功能

| 页面 | 说明 |
| --- | --- |
| **JSON 格式化** | 美化（2 空格 / 4 空格 / Tab）；语法错误提示，浏览器提供位置时显示行列并跳转；树形折叠、按层级展开、key/值搜索与高亮跳转；一键复制 |
| **JSON 压缩** | 去除空白压缩为单行；提示无效 JSON，显示可用的行列位置 |
| **JSON 转义 / 去转义** | 文本与 JSON 字符串互转，一键复制 |
| **JSON 对比** | 双 JSON 结构化 diff（新增 / 删除 / 变更 / 类型变化）；数组按下标或主键配对；可忽略指定路径；树形高亮与「只看差异」；文本逐行 diff |

格式化与压缩页面还支持通过文件选择器或拖拽导入一个本地 UTF-8 `.json` 文件（最大 50 MiB）。导入后输入区保留文件原文，并自动执行当前格式化或压缩操作。大输入始终保留只读虚拟预览，语法出错时也在预览内定位浏览器提供的错误位置。

侧边栏可在各工具页之间切换。界面支持中文（简体）与英文（`_locales/`）。

## 本地加载（开发者模式）

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本仓库**根目录**（包含 `manifest.json` 的目录，不要选 `dist/` 里的 zip）
5. 点击工具栏中的扩展图标，即可打开 JSON 工具箱

快捷键：多数页面支持 **Cmd/Ctrl + Enter** 执行当前操作。

## 项目结构

```
manifest.json          # 扩展清单，仍从仓库根目录加载
*.html                 # 五个工具页的稳定入口
src/
  background.js        # Service Worker：点击扩展图标时打开工具页
  pages/               # 页面交互、视图状态与渲染
    formatter.js
    compare.js
    transform.js       # 压缩、转义、去转义共用页面逻辑
  shared/              # 导航、国际化、虚拟树/文本视图、复制与 Worker 协议
  core/                # 纯算法：JSON 排版、路径、搜索、结构对比、文本对比等
  worker/
    index.js           # Web Worker 消息入口
    tasks.js           # 操作分发、搜索数据缓存与错误响应
styles/app.css         # 五个页面共用样式
icons/                 # 扩展图标（manifest 引用）
_locales/              # 国际化文案
tests/                 # 算法与通信契约、发布文件检查
bench/                 # 搜索/对比算法基准与可选浏览器验证
package.json           # 原生 ES modules 与测试命令，无第三方依赖
gen_icons.py           # 重新生成 icons/ 下 PNG（可选）
build_release.py       # 发布检查与白名单打包（Python 标准库）
STORE_LISTING.md       # Chrome 商店上架文案与表单说明
PRIVACY.md             # 中英文隐私政策（由当前公开仓库托管）
store-assets/          # 商店截图、宣传图与生成脚本（不打进扩展 ZIP）
```

运行时代码使用浏览器原生 ES modules，无需安装依赖或构建即可加载扩展。每个 HTML 只加载一个页面入口，导航生成后统一应用翻译，不依赖全局函数和多个 script 标签的先后顺序。

| 边界 | 职责与约定 |
| --- | --- |
| `pages → shared` | 页面管理自己的状态；共享层负责浏览器交互。格式化树和对比树保留各自的展开、搜索及差异逻辑。 |
| `pages/shared → core` | 视图使用 JSON Pointer 与文本行偏移索引；JSON 解析、搜索与对比通过 Worker 执行。 |
| `shared/worker-client → worker/index` | 请求按 id 配对，全部完成才结束忙碌状态。页面启用串行队列，同类未发送任务只保留最新输入；清空取消排队任务，取消结果带 `cancelled: true`。 |
| `worker/tasks → core` | 每个 Worker 独立缓存文档与最近一次对比。页面通过 `retainSnapshot`/`snapshotId` 复用解析结果；`includeData: false` 省略对象传输，切树视图再取。清空使快照失效，压缩页不保留不需要的搜索数据。 |
| `core` | 不依赖 DOM、Chrome API 或 Worker 全局对象；无效输入抛出异常，由任务层转换为错误响应。数字原文字面量的扫描与恢复集中在 `json.js`。 |

共享虚拟视图负责窗口索引和 DOM 生命周期；页面保留各自的搜索、配对、筛选和导航逻辑。新增任务时，先将算法放入 `core/`，再接入 `worker/tasks.js`；新增运行时文件还需加入 `build_release.py` 的白名单。

## 开发验证

需要 Node.js 20+ 和 Python 3，无需 `npm install`：

```bash
npm test
python3 build_release.py --check
```

测试覆盖数字字面量与特殊 key、搜索缓存与结果上限、结构及文本对比、Worker 并发和故障响应，以及发布包的间接模块依赖。浏览器交互仍需按下文的功能清单验证。

### 性能验证

运行 `npm run bench` 测量搜索与对比算法性能。比较结果时，应在相同环境下串行运行基准。

可选的浏览器验证覆盖大文本、虚拟树、导航和 Worker 数据传输，需要本地已有 Playwright 与 Chromium：

```bash
# 若本地可直接 import playwright，则无需设置此变量。
export PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs
# 可选：export CHROMIUM_EXECUTABLE=/path/to/chromium
node bench/browser.mjs . --verify
node bench/file-import.mjs .
node bench/text-view.mjs
node bench/tree-view.mjs
node bench/worker-transfer.mjs
```

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

大输入和大结果使用虚拟显示，浏览器原生查找仅覆盖可见窗口，可使用树搜索或复制完整文本。输入和结果仍完整保留在内存中；较大的文本差异采用整块替换展示。

日常使用优先按上文加载扩展。仅预览页面时可运行 `python3 -m http.server 8000`，访问 `http://localhost:8000/formatter.html`；原生模块不支持直接双击 HTML 的 `file://` 方式，HTTP 预览也不提供 Chrome 扩展国际化 API。

## 重新生成图标

需要 Python 3，无第三方依赖：

```bash
python3 gen_icons.py
```

输出目录为 `icons/`（会覆盖现有 PNG）。

## 打包发布

需要 Python 3，无第三方依赖：

```bash
python3 build_release.py --check
python3 build_release.py
```

脚本检查版本号、两种语言的名称和简介长度、翻译键、图标尺寸、HTML 资源引用，以及 JavaScript 静态导入和 Worker 入口的相对路径，再按白名单打包运行时文件。输出为 `dist/json-toolbox-<version>.zip` 和对应的 `.zip.sha256` 校验文件。`manifest.json` 位于 ZIP 根目录；测试、文档、截图、开发配置和 `.git` 不会被收录。`dist/` 已加入 Git 忽略规则。

上传前将 ZIP 解压到一个新目录，在 `chrome://extensions/` 中加载该目录并完成下面的检查。以后发布更新时先提高 `manifest.json` 的版本号，再重新打包。

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
- 在中文和英文浏览器语言下检查文字，断网后重复主要操作。
- 发布材料与实际版本保持一致，不承诺未经验证的文件处理速度。
