# 用户增长功能 Task（分支 `feat/growth-features`）

> 本文件只用于规划和跟踪进度，不会打进发布包（`build_release.py` 只打包 `RUNTIME_FILES` 里的 `src/` 文件）。
> 每个功能完成后勾选对应条目。决策 D1–D8 已于 2026-11-28 确认（见第 2 节）；D1 仍要以 T1.0 Spike 的结果为准，方案 A 不可行时退回方案 B。

## 0. 目标与范围

| 编号 | 功能 | 用户价值 | 新增权限 |
| --- | --- | --- | --- |
| F1 | 自动格式化 JSON 页面 | 打开 API 地址即可直接查看树视图，这是商店搜索用户最期待的功能，也是每天都会被动用到的场景 | `scripting`（不弹警告）、可选的网站访问权限（由用户主动开启） |
| F2 | 右键菜单：“用 JSON 工具箱打开选中文本” | 不用复制粘贴，一步打开 | `contextMenus`、`activeTab`、`storage`（都不弹警告） |
| F3 | JSONC / JSON5 宽松解析 | 粘贴带注释的配置或 JS 对象时不再报错，减少差评 | 无 |
| F4 | JSON ↔ YAML 双向转换 | 覆盖 K8s、CI 配置等场景，带来长尾搜索流量 | 无 |
| F5 | 商店页面优化 | 名称和简介带关键词、按语言本地化关键词、截图加标语 | 无 |

**不在本期范围**：NDJSON、JSONPath、转 CSV/TypeScript、Edge 和 Firefox 上架、网页版。

## 1. 全局约束（每个 PR 都要遵守）

- **隐私卖点不能破**：
  - 不发网络请求，不加载远程代码，不做统计
  - CSP 的 `connect-src 'none'` 保持不变
  - 安装时**不出现任何权限警告**，网站访问权限只能在用户主动开启后申请
  - 页面内容只在本地内存中处理，不写入磁盘
- **发布门禁要同步修改，不能删除**：`scripts/build_release.py` 现在禁止所有 `permissions` 和 `optional_host_permissions` 等字段。要改成**白名单精确匹配**，白名单外的任何权限仍然拒绝，`tests/test_release.py` 同步更新。
- **测试**：按 `AGENTS.md` 的归属表放到对应测试文件，新文件同步登记到归属表。每个 PR 都要运行：
  - 受影响文件的 `node --test tests/<name>.test.js`
  - `npm test`
  - `npm run check:release`
  - 改动算法时加跑 `npm run bench:budget`
- **i18n**：
  - 新增文案要同时补齐 20 个 locale（`check_release` 会检查键是否一致）
  - 门禁会拒绝未使用的翻译键，所以**只给商店截图用的文案不能放进 `_locales`**
- **数字精度**：所有新的解析和转换路径都要沿用现有的数字字面量保真。验收用例至少包含 `9007199254740993`、`1.10`、`1e400`、`-0`。
- **大输入**：解析和转换都在 Worker 里执行，结果用 `virtual-text` 或 `virtual-tree` 展示。50 MiB 输入不能卡死界面，并且要能取消。

## 2. 决策（2026-11-28 已确认：全部采用建议方案）

| 编号 | 问题 | 结论 | 未采用的备选 |
| --- | --- | --- | --- |
| D1 | F1 的渲染方式 | **A：用 iframe 嵌入扩展自身的 `viewer.html`**。可以复用 Worker、虚拟树和现有 CSP，大文件性能有保障 | B：在页面内用 Shadow DOM 渲染（页面里拿不到扩展的 Worker，大文件会卡主线程）；C：把标签页跳转到扩展页（地址栏会丢失原始 URL，刷新行为也会变） |
| D2 | F1 的开启方式 | **默认只提供按需模式**（在页面右键选“格式化此页 JSON”，靠 `activeTab` 获得临时权限）。**自动模式需要用户在设置里开启**，开启时申请可选权限 | 安装时就申请 `<all_urls>`（会弹警告，并破坏“零权限”卖点，不建议） |
| D3 | F1 自动模式的权限范围 | `optional_host_permissions: ["http://*/*", "https://*/*", "file:///*"]`。`file://` 还需要用户在 chrome://extensions 里打开“允许访问文件网址” | 只申请 `https://*/*` |
| D4 | F1 是否识别 `text/plain` 中的 JSON | **默认关闭**，可以在设置里开启（只处理开头是 `{` 或 `[`、且能完整解析的内容） | 默认开启 |
| D5 | F3 的交互方式 | **自动降级**：先按严格 JSON 解析，失败后自动尝试 JSON5；成功时提示“已按 JSONC/JSON5 解析，注释已去除，输出为标准 JSON”。不需要开关，也不需要保存偏好 | 页面上加“宽松模式”开关（需要保存偏好，PRIVACY 也要改） |
| D6 | F3 遇到 `Infinity` / `NaN`（标准 JSON 无法表示） | **报错并定位**，不悄悄改数据 | 转成 `null` 或字符串并提示 |
| D7 | F4 的 YAML 解析器 | **引入 `yaml`（eemeli/yaml，ISC 协议）**，参照 CodeMirror 的做法建一个可复现的 vendor 构建，CI 校验构建结果与仓库一致。生成 YAML 的部分自己实现 | `js-yaml`（体积更小，但错误位置信息和规范兼容性较弱）；完全自己写解析器（不建议） |
| D8 | F4 的页面组织 | **新增 `yaml.html` 和 `json-from-yaml.html` 两个页面，各占一个导航项**，和现有的“转义 / 去转义”保持一致，并复用 `transform.js` | 一个页面加方向切换开关 |

## 3. 发布切分（建议按 PR 顺序推进）

| PR | 内容 | 版本 | 理由 |
| --- | --- | --- | --- |
| 1 | F3 宽松解析 | 1.8.0 | 不涉及权限，风险最低，能最先减少差评 |
| 2 | F4 JSON ↔ YAML | 1.9.0 | 不涉及权限，新增 vendor 依赖 |
| 3 | 权限门禁白名单 + F2 右键菜单 | 1.10.0 | 第一次引入权限（都不弹警告），单独发布更容易观察审核和用户反馈 |
| 4 | F1 自动格式化 JSON 页面 | 1.11.0 | 改动最大，依赖 PR3 的权限基础设施 |
| 5 | F5 商店页面优化 | 不发新包，只更新商店信息 | 等功能都上线后再截图和写关键词；只改名称和简介的部分可以随 PR1 提前做 |

> [!NOTE]
> `contextMenus`、`scripting`、`activeTab`、`storage` 都不会触发安装或更新时的权限警告，`optional_host_permissions` 在安装时也不提示。所以更新后**扩展不会被自动停用**。PR3 和 PR4 提交前，要在商店后台的预览里确认没有出现新的警告。

---

## F3. JSONC / JSON5 宽松解析（PR1）

### 方案

新增 `src/core/lenient-json.js`，把 JSONC/JSON5 文本**单遍转换成标准 JSON 文本**，同时记录位置映射。转换后的文本直接交给现有的 `formatJson` / `parseJsonPreservingNumberLiterals` 处理。这样数字保真、树模型、搜索、对比都不用改。

### 任务

- [ ] **T3.1 转换器 `core/lenient-json.js`**
  - 注释：`//`、`/* */`（去掉；块注释没有闭合时报错，并定位到注释开头）
  - 末尾逗号：对象和数组都支持
  - key：不加引号的 ES5 标识符（包括 Unicode 和 `\uXXXX` 转义）；单引号 key
  - 字符串：单引号字符串（转成双引号，处理 `'` 和 `"` 的转义）；行尾 `\` 续行；`\x41`、`\v`、`\0` 转成 JSON 合法的转义
  - 数字：
    - `0xFF` 转成 `255`，大数用 BigInt 保证精确
    - `+1` 转成 `1`；`.5` 转成 `0.5`；`5.` 转成 `5`
    - 其他字面量保留原文
  - `Infinity` / `NaN` / `-Infinity`：按 D6 报错，并给出原文位置
  - 空白：允许 JSON5 规定的额外空白（`\v`、`\f`、NBSP、BOM、U+2028/2029）
  - 输出 `{ text, mapOffset(pos) }`，错误以 `SyntaxError` 抛出，并带原文的 `position`
  - 复杂度 O(n)，用数组分块拼接，避免反复拼接字符串
- [ ] **T3.2 接入 Worker**（`worker/tasks.js`）
  - `format`、`minify`、`compare` 先走严格解析；只有抛出 `SyntaxError` 时才调用转换器重试
  - 返回结果增加 `lenient: true | false`
  - 转换器也失败时，**返回转换器的错误位置**（它的语法覆盖面更大，错误信息更准确）
  - 快照和缓存的键仍然用原始输入文本
- [ ] **T3.3 页面提示**
  - `formatter.js`、`transform.js`（只处理 minify）、`compare.js`：`lenient` 为 true 时，在状态栏显示提示（新增 i18n 键 `statusLenientParsed`）
  - 对比页需要分别标明左右两侧的状态
- [ ] **T3.4 i18n**：20 个 locale 都补上 `statusLenientParsed`，错误信息复用现有的 parse error 文案
- [ ] **T3.5 测试**
  - `tests/lenient-json.test.js`（新文件，登记到 AGENTS 归属表的“格式化”一行）：
    - 用表驱动，覆盖 T3.1 每一项的“输入 → 标准 JSON 输出”
    - 错误位置：未闭合注释、`Infinity`、非法标识符
    - 数字精度：`0x1FFFFFFFFFFFFF1` 转成十进制后精确
  - `tests/tasks.test.js`：增加 `lenient` 字段的契约用例（严格输入为 false，JSONC 输入为 true）
  - `tests/formatter-rendering.test.js`：只验证提示的接线是否正确，不重复测试 core 的各种边界
  - 严格 JSON 的路径不能有额外开销：`npm run bench:budget` 必须通过；`bench/format.mjs` 增加一个 JSONC 降级场景作为参考数据
- [ ] **T3.6 文档**：README（中英文）、`STORE_LISTING.md` 和 20 个 `listing.txt` 的功能列表里加上 “JSONC / JSON5”

**验收标准**
- [ ] 粘贴 VS Code 的 `settings.json`（带注释和末尾逗号）后能正常格式化，并显示提示
- [ ] 粘贴 `{a: 1, 'b': [0xFF, .5,],}` 后输出 `{"a":1,"b":[255,0.5]}`
- [ ] 严格 JSON 的行为和性能都没有变化
- [ ] 错误能定位到原文中的正确行列

---

## F4. JSON ↔ YAML（PR2）

### 任务

- [ ] **T4.1 YAML 生成器 `core/yaml-emit.js`（自己实现，不依赖第三方库）**
  - 基于数据和 `numberLiterals` 输出 YAML 1.2，缩进 2 格；`[]`、`{}` 写成 flow 形式
  - **以下字符串必须加引号**：
    - 会被识别成其他类型的值：`true`、`false`、`null`、`~`、YAML 1.1 的 `yes/no/on/off/y/n`（不区分大小写）
    - 看起来像数字的值：`0123`、`1_000`、`1:20`、`.inf`、`.nan`、`0x1F`
    - 空字符串，以及首尾带空格的字符串
    - 以 ``-?:,[]{}#&*!|>'"%@` `` 等字符开头，或包含 `: `、` #` 的字符串
  - key 的引号规则与上面相同
  - 多行字符串：用 `|` 块格式，并按需加 chomping 指示符（`|-` / `|+`）。行首有空格时需要写缩进指示符，否则改用双引号
  - 控制字符、U+2028/2029 和单独的代理项，在双引号字符串里转义
  - 数字直接输出原文字面量（例如 `1.10`、`1e400`、大整数）
  - 大文档分块输出，避免产生一个巨型字符串
- [ ] **T4.2 引入 YAML 解析器（按 D7 选定 `yaml`）**
  - 新建 `scripts/vendor-yaml/`，结构参照 `scripts/vendor-codemirror/`：`package.json`、lock 文件、构建脚本，产物为 `src/vendor/yaml.js` 和 `yaml.LICENSE.txt`
  - CI 的 `check.yml` 增加“vendor 构建结果可复现”这一步
  - `RUNTIME_FILES` 登记新文件；记录体积，目标是压缩后 ≤ 120 KB
- [ ] **T4.3 YAML → JSON 的语义 `core/yaml-to-json.js`**
  - 使用 core schema，所以 timestamp 保持为字符串
  - anchor 和 alias 会展开，并设置 `maxAliasCount` 防御 billion-laughs 攻击
  - 多文档（`---`）输出为 JSON 数组，并提示
  - 非字符串的标量 key（如 `1`、`true`）转成字符串；复杂 key（映射或序列作为 key）报错
  - `.inf` / `.nan` 报错（与 D6 一致）；自定义 tag 和 `!!binary` 报错
  - **数字保真**：根据源 token 取原始文本，生成 JSON 时直接写原文（如 `9007199254740993`、`1.10`）
  - 错误转换成现有的 `{ line, column }` 结构，让输入框能定位到出错位置
- [ ] **T4.4 Worker 动作**：新增 `toYaml` 和 `fromYaml`，复用取消和串行化逻辑；`fromYaml` 的输出使用当前页面选择的缩进
- [ ] **T4.5 页面**
  - 新增 `yaml.html`（JSON → YAML）和 `json-from-yaml.html`（YAML → JSON），按 D8 复用 `transform.js` 的 `data-action` 模式
  - 文件导入要接受 `.yaml` / `.yml`（`file-import.js` 当前只接受 `.json`，改成按页面配置）
  - `navigation.js` 增加两个导航项和图标
  - 两个页面都放一个“交换方向”入口，跳转到另一个页面并带上当前输出
- [ ] **T4.6 i18n**：导航名、页面标题、placeholder、错误文案（多文档、alias 超限、不支持的 tag），20 个 locale 都要补齐
- [ ] **T4.7 测试**
  - `tests/yaml.test.js`（新文件，登记到 AGENTS 归属表的“格式化”一行）：
    - 生成器：用表驱动覆盖 T4.1 的引号规则和多行字符串
    - 解析语义：覆盖 T4.3 各项
    - **往返性质测试**：用固定随机种子生成 JSON，经过 JSON → YAML → JSON 后结果完全一致（包括数字原文），以此检验所有引号规则
  - `tests/tasks.test.js`：两个新动作的参数和返回契约
  - `tests/transform-input.test.js` / `transform-copy.test.js`：新页面的接线，不重复测试 core 的边界
  - `tests/test_release.py`：vendor 文件缺失时检查失败
  - `bench/`：增加一个 25 MiB 的 JSON → YAML 基准，作为参考数据
- [ ] **T4.8 文档**：README、STORE_LISTING、listing 里加上 “JSON to YAML / YAML to JSON”

**验收标准**
- [ ] `{"country":"NO","v":"1.0","port":"0123"}` 转出的 YAML 用 PyYAML（1.1）和 `yaml`（1.2）读回都是字符串
- [ ] 一个 K8s Deployment YAML 转成 JSON 再转回来，语义不变
- [ ] 往返性质测试稳定通过
- [ ] 错误能定位到原文中的正确行列

---

## 权限基础设施 + F2 右键菜单（PR3）

### 任务

- [ ] **T2.0 发布门禁改成白名单**（`build_release.py`）
  - `permissions` 必须 ⊆ `{contextMenus, activeTab, scripting, storage}`
  - `optional_host_permissions` 必须 ⊆ D3 选定的集合；**`host_permissions` 和静态 `content_scripts` 继续禁止**
  - `web_accessible_resources` 在 PR4 才放开（只允许 viewer 入口，并且必须 `use_dynamic_url: true`）
  - `tests/test_release.py`：
    - 白名单内的权限可以通过
    - `tabs`、`<all_urls>` 出现在 `host_permissions`、静态 `content_scripts` 这几种情况仍然拒绝
- [ ] **T2.1 注册菜单**（`background.js`）
  - 在 `runtime.onInstalled` 中创建菜单：`contexts: ['selection']`，标题用 i18n 键 `menuOpenSelection`
  - 菜单的父级标题会显示扩展名，所以 manifest 增加 `short_name: "JSON Toolbox"`，避免 F5 改名后名称过长
- [ ] **T2.2 获取选中文本**
  - 优先用 `activeTab` 加 `scripting.executeScript` 取精确文本：
    - 普通页面用 `getSelection().toString()`
    - 焦点在 `textarea` / `input` 里时，用 `selectionStart` 和 `selectionEnd` 截取
  - 注入失败时（如 `chrome://` 页面、商店页面、PDF）回退到 `info.selectionText`，并提示“空白可能已被规范化”
  - Spike：验证 `selectionText` 的换行折叠和长度上限，把结论写进代码注释
- [ ] **T2.3 把文本传给工具页**
  - 后台生成一次性 token，把文本写入 `chrome.storage.session`（只在内存中，配额 10 MB）
  - 在当前标签页右侧打开 `formatter.html?import=<token>`（设置 `index` 和 `openerTabId`）
  - 工具页读取后**立即删除**这条记录，读不到时提示“内容已过期”
  - 超过 10 MB 时提示用户改用复制粘贴或文件导入
  - `formatter.js` 载入后自动执行格式化；如果内容按 JSON5 解析成功，同样显示 F3 的提示
- [ ] **T2.4 i18n**：`menuOpenSelection`、`errSelectionTooLarge`、`errImportExpired` 等，20 个 locale 都要补齐
- [ ] **T2.5 测试**
  - 新建 `tests/background.test.js`，模拟 `chrome.*` API，验证：
    - 菜单只创建一次
    - 回退路径正确
    - 超过 10 MB 时报错
  - 页面的 token 读取并删除：放进 `formatter-rendering.test.js`
  - 浏览器端到端测试：扩展 `bench/release-smoke.mjs`，覆盖“选中文本 → 右键菜单 → 新标签页显示格式化结果”（Playwright 无法点击原生右键菜单，改为直接调用 `contextMenus.onClicked` 对应的处理函数）
- [ ] **T2.6 隐私和商店信息**
  - `PRIVACY.md`：说明只在用户点击菜单时读取选中文本，并且只保存在内存中
  - `STORE_LISTING.md` 的权限理由：为 `contextMenus`、`activeTab`、`scripting`、`storage` 各写一条
  - README 的“零权限”改成“**零网站访问权限、安装无权限警告**”

**验收标准**
- [ ] 选中网页上的 JSON（包括 textarea 里的内容）后用右键菜单打开，结果和直接粘贴完全一致
- [ ] 安装和更新时都没有权限警告
- [ ] `storage.session` 里没有残留数据

---

## F1. 自动格式化 JSON 页面（PR4）

### 任务

- [ ] **T1.0 Spike（1–2 天，结论写进 PR 描述）**
  - 验证 D1-A 能否行得通：
    - 在 `application/json` 页面里插入 `chrome-extension://…/viewer.html` 的 iframe，会不会被页面 CSP 或 COEP 拦截
    - 扩展 CSP 的 `frame-ancestors 'none'` 必须放宽，评估能否只放宽到 `http: https: file:`，并同步修改 `REQUIRED_EXACT_CSP` 门禁
  - 适配 Chrome 自带的 JSON 显示：
    - 新版 Chrome 会给 JSON 响应加一个 “Pretty-print” 复选框
    - 记录这种情况下的 DOM 结构，确保只取原始的 `<pre>` 文本
  - 传输：用 `MessageChannel` 加可转移的 `ArrayBuffer`（UTF-8）传 50 MiB 文本，测量耗时
  - 如果 A 行不通，退回 D1-B，并对大文件设置上限（例如超过 5 MiB 时只显示“在工具页打开”按钮）
- [ ] **T1.1 检测脚本 `content/detect.js`（经典脚本，体积尽量小）**
  - 必须同时满足以下条件才接管页面：
    - `document.contentType` 是 `application/json`、`text/json`、`*+json`（D4 开启后也包括 `text/plain`）
    - `body` 里只有一个 `<pre>`（允许 Chrome 自带的 Pretty-print 容器）
    - 只在顶层框架运行
  - 内容能完整解析时才替换页面；解析失败就保持原样，不打扰
  - 保留原始文本和 URL；工具栏提供 **原文 / 格式化** 切换、复制、“在工具页打开”（复用 F2 的 token 通道）
- [ ] **T1.2 Viewer 页面 `viewer.html`**
  - 复用 `virtual-tree`、`document-session` 和搜索，去掉侧边栏和输入框，只读
  - 跟随主题设置（`localStorage` 和工具页同源，可以共享）
  - 注册为 `web_accessible_resources`：`matches` 与 D3 一致，并设置 `use_dynamic_url: true` 防止被网站用来探测是否安装了扩展
- [ ] **T1.3 按需模式（D2）**
  - 页面右键菜单（`contexts: ['page']`）增加“格式化此页 JSON”：通过 `activeTab` 获得临时权限，然后注入 `detect.js`
  - 检测不通过时提示“此页面不是 JSON”
- [ ] **T1.4 自动模式开关**
  - 侧边栏 “Appearance” 下方新增 “Settings” 区域，放一个“自动格式化网页中的 JSON”开关（`role="switch"`）
  - 打开开关时，在用户手势内调用 `chrome.permissions.request(D3)`，获得授权后用 `chrome.scripting.registerContentScripts`（`runAt: 'document_start'` 避免页面闪烁，`allFrames: false`）注册脚本
  - **以权限状态作为开关状态**，不额外存储偏好
  - 关闭开关时 `permissions.remove` 并 `unregisterContentScripts`
  - 后台在 `permissions.onAdded` / `onRemoved` 和 `runtime.onStartup` 时对齐注册状态（用户可能在 chrome://extensions 里直接撤销权限）
  - 用户没有开启“允许访问文件网址”时，`file://` 页面要给出引导说明
- [ ] **T1.5 门禁**：放开 `web_accessible_resources` 白名单（只允许 viewer 相关文件，且必须 `use_dynamic_url`），按 Spike 结论调整 CSP 的 `frame-ancestors`；`test_release.py` 同步更新
- [ ] **T1.6 i18n**：开关文案、权限说明、菜单项、原文 / 格式化切换、不是 JSON 页面的提示，20 个 locale 都要补齐
- [ ] **T1.7 测试**
  - `tests/content-detect.test.js`：
    - 用表驱动覆盖 content-type、DOM 结构、解析失败时保持原样
    - 使用 `page-dom.js` 提供的最小 DOM
  - `tests/background.test.js`：权限变化时注册状态能正确对齐
  - `tests/sidebar.test.js`：开关接线，以及申请被拒后能恢复原状态
  - 浏览器测试：新建 `bench/auto-format.mjs`，复制一份 manifest 到临时目录并直接写入 host 权限（不修改源码，也不在测试里点击权限弹窗），用 `route.fulfill` 提供 1 KB 和 50 MiB 的 JSON，验证：
    - 树视图能显示
    - 原文 / 格式化能切换
    - 带 CSP 的页面能降级处理
    - 主线程长任务时间在预算内
  - `bench/accessibility.mjs` 和 `theme.mjs` 覆盖 viewer 页面
- [ ] **T1.8 隐私和商店信息**
  - `PRIVACY.md`：只有在用户开启自动模式或点击菜单后，才读取**内容类型为 JSON 的页面**；内容只在本地内存中处理，不保存
  - 商店后台：可选网站访问权限的理由，以及更新“隐私权规范”表单
  - README：新增“自动格式化”章节，说明默认不开启

**验收标准**
- [ ] 默认安装后网页完全不受影响
- [ ] 开启自动模式后，打开 `https://api.github.com/repos/michaelHMK/json-toolbox` 直接显示树视图，并能切换回原文
- [ ] 撤销权限后，自动格式化立即失效
- [ ] 50 MiB 的 JSON 响应不会让标签页卡死
- [ ] 安装时没有权限警告

---

## F5. 商店页面优化（PR5，名称和简介可以随 PR1 先改）

> [!WARNING]
> Chrome Web Store 的政策禁止**关键词堆砌**和与功能无关的关键词。名称要读起来自然，只写已经上线的功能。功能上线前，不要在名称和描述里写它。

- [ ] **T5.1 名称加关键词**（manifest 的 `extName`，门禁要求 ≤ 75 字符）
  - 英文：`JSON Toolbox – Formatter, Viewer, Diff & YAML`（YAML 等 F4 上线后再加）
  - 中文：`JSON 工具箱 – 格式化、查看、对比与 YAML 转换`
  - 加上 `short_name: "JSON Toolbox"`（与 T2.1 共用），供菜单和启动器等空间较小的位置使用
- [ ] **T5.2 简短描述**（`extDescription`，门禁要求 ≤ 132 字符）
  - 开头直接写关键词，去掉重复的 “High-performance JSON Toolbox”
  - 英文示例：`Format, view & compare JSON, auto-format JSON pages, JSONC/JSON5 and YAML. 100% local: no ads, tracking or data collection.`
  - 中文示例：`JSON 格式化、查看与对比，网页 JSON 自动美化，支持 JSONC/JSON5 和 YAML 互转。数据全程本地处理，无广告、无追踪。`
- [ ] **T5.3 按语言本地化关键词**
  - 新建 `store-assets/keywords.md`：为每个 locale 列出 3–5 个核心搜索词，以及它们在名称、简介、详细描述第一段中的位置
  - 调研方法：
    - 商店在该语言下的搜索联想
    - 该语言前 10 名竞品的标题
    - 使用当地开发者的习惯说法（例如日语 “JSON 整形”、德语 “JSON formatieren”、韩语 “JSON 포맷터”、俄语 “форматирование JSON”）
  - 同步修改 20 个 `_locales/*/messages.json` 的 `extName` / `extDescription`，以及 `store-assets/*/listing.txt`
  - 详细描述的前两行（商店折叠时只显示这部分）必须包含核心关键词
  - 小语种：机器翻译初稿 + 复核清单（标出未经母语者确认的 locale）
- [ ] **T5.4 截图（1280×800，5 张）**
  - 新的顺序，第一张最关键：
    1. 自动格式化 API 页面（地址栏可见真实 URL）
    2. 结构化对比 + 忽略路径
    3. JSONC/JSON5 宽松解析
    4. JSON ↔ YAML
    5. 50 MiB 大文件 + 主题
  - 每张截图顶部加**本地化标语**（例如 “打开 API 即可看懂” “忽略时间戳的结构化 Diff”）：
    - 标语文案放在 `scripts/store-assets/captions.json`，不放进 `_locales`，避免被门禁当作未使用的键
    - 改造 `scripts/store-assets/generate.mjs`：先截图，再用 HTML 模板合成标语
  - 自动格式化的截图沿用 T1.7 的“临时复制 manifest + `route.fulfill`”方案
  - 同步更新 `promos.mjs` 的宣传图标语，然后重新生成 20 个 locale
- [ ] **T5.5 上架**
  - 在商店后台逐个 locale 粘贴新的描述和截图
  - 记录调整前后 4 周的曝光、详情页访问、安装和周活，用来对比效果，并写进本文件末尾的“效果记录”

---

## 4. 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 页面 CSP 拦截扩展 iframe | F1 方案 A 不可用 | 先做 T1.0 Spike，不可用时退回方案 B 并限制文件大小 |
| 引入权限后商店审核变慢，或被要求补充说明 | 发布延迟 | 权限理由写清楚；PR3 和 PR4 分开发布 |
| 用户觉得“零权限”的承诺变了 | 口碑受损 | 默认零网站访问，安装无警告；在描述和 PRIVACY 里写清楚自动模式需要用户主动开启 |
| `yaml` 库体积或 CSP 兼容问题 | F4 延期 | 在 T4.2 先验证构建产物不含 `eval` 和 `new Function`，并测量体积；有问题就换 `js-yaml` |
| 关键词被判定为堆砌 | 商店页面被下架 | 遵守 T5 的警告；名称里不超过 4 个功能词 |

## 5. 完成定义（每个 PR）

- [ ] 受影响的测试文件、`npm test` 和 `npm run check:release` 都通过；改动算法时 `npm run bench:budget` 也要通过
- [ ] 浏览器行为有变化时，运行对应的 `bench/` 浏览器脚本
- [ ] 20 个 locale 的翻译键完整，release-smoke 能正常加载
- [ ] `PRIVACY.md` 的更新日期和版本号、`STORE_LISTING.md`、README 中英文都已同步
- [ ] 新测试文件已登记到 `AGENTS.md` 的测试归属表
- [ ] PR 标题使用英文；`chore: bump version to x.y.z` 单独提交

## 效果记录

| 日期 | 版本 / 改动 | 曝光 | 详情页访问 | 安装 | 周活 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| | 基线（1.7.0） | | | | | |
