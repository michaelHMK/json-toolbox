# JSON 工具箱隐私政策 / JSON Toolbox Privacy Policy

更新日期：2026年11月28日。适用版本：1.7.0。

JSON 工具箱用于在浏览器本地格式化、压缩、转义、查看、转换（JSONC/JSON5、JSON ↔ YAML）和比较 JSON，并在你主动触发或开启可选设置时格式化网页中的 JSON。扩展不收集、上传、出售或与第三方共享用户数据。

## 数据处理和存储

你主动输入或粘贴的 JSON / JSONC / JSON5 / YAML、文本、搜索词和对比选项，以及你通过文件选择器或拖拽明确提供的本地 `.json` / `.yaml` / `.yml` 文件内容，只在扩展页面及本地 Worker 的运行内存中处理。扩展仅在执行文件导入时读取所选文件，不会把这些内容发送到服务器，也不会写入云端或持久化保存输入历史。关闭或重新加载工具页后，扩展不保存历史输入记录。

当你在网页选中文本并右键点击「在 JSON 工具箱中打开选中内容」时，扩展仅在点击当次读取所选文本，并通过仅驻留内存的 `chrome.storage.session` 一次性令牌（上限 10 MB）传递给新打开的工具页；工具页读取后立即删除该条目。右键点击「格式化此页 JSON」同样仅在点击当次检查当前激活标签页。

当你在侧边栏主动开启「自动格式化网页中的 JSON」（默认关闭）后，扩展仅在本地内存中读取**内容类型为 JSON 的页面**（若你另外启用「同时格式化纯文本页面」子开关，则也会检查以 `{` 或 `[` 开头且可完整解析的 `text/plain` 响应），并在内嵌的本地 `viewer.html` 视图中展示；非 JSON 页面或解析失败的页面保持原样，不会把网页内容写入磁盘或浏览器存储。

外观默认使用正常模式，你可以手动选择正常、护眼或暗色模式，也可在桌面端收起或展开左侧导航栏。扩展仅将界面偏好（主题选择及侧边栏折叠状态保存在本机 `localStorage`；「同时格式化纯文本页面」布尔偏好保存在本机 `chrome.storage.local`，默认关闭）用于恢复设置，其中不保存输入、网页内容、文件内容或处理结果，也不上传或通过云端同步。

当你执行复制操作时，扩展会将选中的文本、输入内容或处理结果写入系统剪贴板。当你粘贴时，扩展只处理浏览器在该次粘贴操作中提供的文本，不会主动读取剪贴板。复制后的内容由操作系统和剪贴板管理工具管理，可能在扩展页面关闭后仍然保留。

## 权限和第三方服务

扩展在安装和更新时不申请网站访问权限，不触发任何权限警告，也不读取网页内容、浏览历史、Cookie 或账号信息。仅点击工具栏图标只会打开扩展自身的工具页。

- `contextMenus`、`activeTab`、`scripting`、`storage`：仅用于提供选中文本与当前标签页的按需右键菜单、向已获授权或用户触发的标签页注入页面查看脚本、通过内存 `chrome.storage.session` 一次性令牌传入内容，以及在本机 `chrome.storage.local` 保存纯文本页面自动格式化子开关状态。
- 可选网站访问权限（`http://*/*`、`https://*/*`、`file:///*`）：默认不请求。只有当你在侧边栏主动开启「自动格式化网页中的 JSON」时才会发起授权提示；`file://` 本地文件页面还需你在 `chrome://extensions` 中自行开启「允许访问文件网址」。随时关闭开关或在浏览器扩展设置中撤销权限后，自动格式化立即停止。

扩展不发起网络请求，不加载远程代码，不包含广告、分析统计或第三方追踪 SDK。浏览器和 Chrome Web Store 自身的下载、更新及平台服务由其各自的隐私政策管理。

## 联系和变更

如有隐私问题，请通过本扩展 Chrome Web Store 详情页提供的开发者联系邮箱联系开发者。处理方式发生变化时，将更新本政策和对应的商店隐私声明。

## English

Last updated: November 28, 2026. Applies to version 1.7.0.

JSON Toolbox processes JSON, JSONC/JSON5, YAML and text locally in your browser for formatting, minification, escaping, viewing, conversion and comparison, and optionally formats JSON responses in web pages when you invoke or enable it. The extension does not collect, upload, sell or share user data with third parties.

### Processing and storage

JSON, JSONC/JSON5, YAML, text, search queries and comparison settings that you enter or paste, plus the contents of local `.json`, `.yaml` or `.yml` files that you explicitly provide through a file picker or drag-and-drop, are processed only in the memory of the extension page and its local Worker. The extension reads a selected file only when you import it, does not transmit any content to servers or cloud services, and does not retain input history across closes or reloads.

When you highlight text and right-click "Open selection in JSON Toolbox", the extension reads only that selection on click and passes it to the new tool tab via an in-memory one-time token in `chrome.storage.session` (10 MB limit), which is deleted immediately once read. Clicking "Format JSON on this page" likewise inspects only the active tab on demand.

If you explicitly turn on "Auto-format JSON pages" in the sidebar (OFF by default), the extension reads in local memory only **pages whose content type is JSON** (or `text/plain` starting with `{` or `[` that parses completely as JSON, only if you also turn on the separate "Also format plain-text pages" sub-option) and renders them inside a local embedded `viewer.html` frame. Non-JSON or unparseable pages are left untouched, and page contents are never written to disk or persistent storage.

Appearance defaults to Normal, and you can manually choose Normal, Eye comfort or Dark, as well as collapse or expand the sidebar on desktop. The extension stores only local UI preferences on your device (theme choice and sidebar collapsed state in `localStorage`; the optional "Also format plain-text pages" toggle, default off, in `chrome.storage.local`). This storage contains no input, webpage content, file content or processing results, and is never uploaded or synced through cloud services.

When you copy, the extension writes the selected text, input or result to the system clipboard. When you paste, the extension processes only the text your browser provides for that paste. It does not read the clipboard independently. Copied content is managed by your operating system and clipboard tools and may remain after the extension page closes.

### Permissions and third parties

By default, the extension requests no website access on install or update, produces zero permission warnings, and does not read website content, browsing history, cookies or account information. Clicking the toolbar icon opens only the extension's own tool page.

- `contextMenus`, `activeTab`, `scripting`, `storage`: used strictly for on-demand right-click actions ("Open selection in JSON Toolbox" and "Format JSON on this page"), injecting the JSON detector into a user-triggered or user-authorized tab, transferring the one-time selection token in memory via `chrome.storage.session`, and saving the optional plain-text toggle in `chrome.storage.local`.
- Optional host permissions (`http://*/*`, `https://*/*`, `file:///*`): not granted by default. Requested only when you explicitly turn on "Auto-format JSON pages" in the sidebar (`file://` URLs also require turning on Chrome's "Allow access to file URLs" switch). Turning the switch off or revoking site permissions stops page access immediately.

The extension makes no network requests, loads no remote code and includes no ads, analytics or third-party tracking SDKs. Downloads, updates and platform services provided by your browser and the Chrome Web Store are governed by their own privacy policies.

### Contact and changes

For privacy questions, contact the developer using the contact email shown on this extension's Chrome Web Store listing. Changes to data handling will be reflected in this policy and the store's privacy disclosures.
