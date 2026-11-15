# AGENTS.md

## 测试维护

以下名称对应 `tests/` 下的测试文件。

| 关注点 | 主要归属 | 上层测试保留的内容 |
| --- | --- | --- |
| 格式化、数字精度、搜索、结构/文本差异 | `format-buffered`、`number-literals`、`search`、`structural-diff`、`text-diff` | Worker 的参数传递与返回数据契约 |
| Worker 缓存、快照、窗口消息 | `tasks`、`snapshots`、`worker-tree` | 页面是否正确发起操作并使用结果 |
| 排队、取消、崩溃、传输与恢复 | `worker-client`、`worker-protocol`、`*-session` | 页面独有的视图选择、旧结果隔离、错误反馈 |
| 虚拟窗口、树操作与文本选择 | `virtual-*`、`remote-tree`、`tree-paths` | 页面接线、焦点和用户可见结果 |
| 文件导入与输入焦点 | `file-import`、`text-input-focus` | 各入口的独特行为；大输入场景放回对应功能文件 |
| 打包与资源依赖 | `test_release.py` | 实际构建产物与缺失依赖的失败行为 |

### 测试工具

- `tests/helpers/page-dom.js`：加载真实页面逻辑的最小 DOM 环境，只验证事件与状态；真实布局、绘制和焦点由 `bench/` 的浏览器脚本验证。
- `tests/helpers/session-worker.js`：运行真实 Worker 任务逻辑，并控制请求完成、暂停和崩溃。
- `format-buffered.test.js` 的容量测试通过源码替换降低字符串上限，执行真实格式化逻辑，避免分配巨型字符串。

### 验证命令

从仓库根目录运行，需要 Node.js 20+ 和 Python 3，无需 `npm install`。

- 代码或测试变更：先运行受影响文件的 `node --test tests/<name>.test.js`，再运行 `npm test`（含 Python 发布测试）和 `npm run check:release`。
- 算法性能变更：运行 `bench/` 下的相应基准及 `npm run bench:budget`；`npm run bench` 可运行格式化、搜索和对比基准。
- 浏览器行为变更：按 [README 的性能验证](README.zh-CN.md#性能验证) 运行相应浏览器检查，需要本地 Playwright 与 Chromium。
