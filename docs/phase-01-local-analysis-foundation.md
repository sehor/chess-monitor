# 阶段 1：本地象棋分析底座

## 目标

建立一个不依赖外部棋盘截图也能使用和测试的本地分析程序：输入合法 FEN 后显示正确局面，支持基本走子与棋谱表示，并由 Pikafish 输出最新局面的 MultiPV、深度、节点数、评估和最佳着。

本阶段同时固定内部坐标、红黑方、评估符号和规则库版本，防止视觉层、规则层、棋盘组件和引擎各自使用不同约定。

## 工具选择

- Electron + TypeScript + Vue 3：桌面壳、类型化 IPC 和界面。
- Vite：Renderer 构建与开发环境。
- xiangqiground：棋盘显示、落子和箭头。
- `@west-shell/xiangqi.js`：FEN、合法走法、局面状态和棋谱能力；锁定精确版本或 Git commit。
- Pikafish：本地分析引擎；二进制版本和 CPU 指令集写入资源清单。
- Vitest：坐标、FEN、规则适配器、评估转换和消息状态测试。
- SQLite 暂只建立访问层接口；实际持久化可在阶段 2 完成。

## 技术路线

1. 建立领域类型：`Side = red | black`、`Orientation = red-bottom | black-bottom`、ICCS 坐标着法和标准 Position/FEN。
2. 用适配器包住规则库，UI 和 Board Tracker 不直接依赖第三方库的内部对象。验证将军、应将、蹩马腿、塞象眼、炮架、九宫、长将/重复等项目需要的规则行为。
3. 用适配器包住 xiangqiground，集中处理 `white = red`、棋盘翻转和 UI 坐标映射。
4. 建立独立 Engine Manager：启动/停止 Pikafish、初始化选项、发送 position/go/stop、解析 info/bestmove、MultiPV、超时和退出事件。
5. 为每次分析分配递增 `analysisId`。切换局面时先标记旧任务失效，再停止旧分析；任何旧 `analysisId` 的消息一律丢弃。
6. 统一评估为“正值红方有利、负值黑方有利”，正确处理引擎 side-to-move 分值、将死分和评估条边界。
7. Renderer 只通过 preload 暴露的类型化 API 操作引擎和文件能力；启用 context isolation，禁用 Renderer 的 Node 直接访问。
8. 实现最小界面：FEN 输入、棋盘、当前行棋方、最佳着箭头、Top N、PV、深度、节点数、评估值和错误提示。

## 交付物

- 可启动的 Electron/Vue 分析程序骨架。
- 规则库和棋盘组件适配层。
- 可独立测试的 Engine Manager。
- FEN 输入、棋盘、MultiPV 和最佳着界面。
- 坐标、符号和消息协议说明。

## 验收标准

当前自动化与现场验收状态见 [阶段 0–1 实施状态](./phase-00-implementation-status.md)。自动化资格门通过不替代官方 Pikafish 二进制和目标设备上的现场复核。

- 50 个覆盖普通局面、将军、将死、和棋、吃子和翻转方向的 FEN 均显示正确。
- 对项目选定规则集建立不少于 100 个规则测试；关键规则用例全部通过。
- 连续快速切换 100 次合法 FEN，界面中旧局面的分析结果出现次数为 0。
- `stop → 新 position → go` 的调度不会死锁；在测试机上 100 次切换均收到新局面的首条有效分析信息。
- 强制结束 Pikafish 后，Engine Manager 能报告明确错误并按策略重启；Renderer 不崩溃。
- 红方和黑方行棋局面的评估符号经已知测试局面验证一致。
- 不联网时仍可完成全部核心分析功能。
