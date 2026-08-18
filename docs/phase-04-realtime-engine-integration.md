# 阶段 4：实时 Pikafish 联动

## 目标

把 `MOVE_CONFIRMED` 与阶段 1 的 Engine Manager 串成完整闭环：每次确认走子后立即更新棋盘和棋谱、取消旧局面分析、启动新局面分析，并只显示最新 Position 的结果。

阶段完成即达到单客户端 MVP：用户完成一次校准后，正常对局无需完整视觉模型即可持续跟踪和分析。

## 工具选择

- Board Tracker 事件流：唯一的实时局面事实来源。
- Engine Manager：Pikafish 生命周期、MultiPV、限时/持续分析和结果隔离。
- Vue 3 + xiangqiground：当前局面、评估条、最佳着箭头、Top N、PV 和状态提示。
- SQLite：棋局、已确认着法、FEN、时间戳和可选分析摘要。
- Vitest：乱序事件、快速连续走子、引擎退出和暂停恢复测试。

## 技术路线

1. `MOVE_CONFIRMED` 事件包含 move、前后 Position 哈希、FEN、序号、捕获时间和确认时间。Renderer 不自行推演第二份局面。
2. 事务性写入新着法和 FEN；成功后发布新的 `positionVersion`。若持久化失败，显示错误并暂停监控，不继续产生不可恢复分叉。
3. Engine Manager 收到新版本时立即使旧 `analysisId` 失效、发送 stop、设置新 position 并开始 go。旧输出即使晚到也不得进入 UI。
4. 把引擎输出规范化为红方视角，处理 mate 分值、MultiPV 排名、PV 着法转换和非法/截断 PV。
5. UI 同时显示跟踪状态和分析状态。`MOVE_ANIMATING`、`DESYNC`、引擎重启和分析中必须有不同提示，避免用户误以为旧评估仍属当前局面。
6. 最佳着箭头和 PV 只在其 `positionVersion` 与当前局面一致时显示；切换局面时先清除旧箭头。
7. 保存每步可配置深度下的最终分析摘要；持续产生的中间 info 不全部写入 SQLite。
8. 支持暂停监控、恢复、手动输入 FEN 和手动重同步，所有入口最终都走同一 Position 版本机制。

## 交付物

- Board Tracker → Persistence → Engine Manager → UI 的版本化事件链路。
- 实时棋盘、着法列表、评估条、Top N、PV、深度、节点数和最佳着箭头。
- 引擎/跟踪双状态提示和故障恢复入口。
- 单客户端 MVP 演示与验收报告。

## 验收标准

- 实时完整跟踪至少 10 盘、累计不少于 500 步，每次确认后 UI 的 FEN、着法列表和引擎 position 均一致。
- 快速连续注入 100 组相邻局面，旧局面分析或箭头显示次数 = 0。
- 在测试机上，`MOVE_CONFIRMED` 到 UI 新局面可见延迟 P95 < 100 ms；到 Pikafish 首条有效新局面信息 P95 < 2 s。
- 强制终止 Pikafish 20 次，应用和跟踪不中断；重启成功后只分析当前最新局面。
- 进入 `DESYNC` 时自动停止提交新分析，并清晰标记当前结果不再可信。
- 关闭并重新打开应用后，可恢复未完成棋局的最后一个已确认局面和着法记录。
- 用户无需安装 Python、PyTorch 或 CUDA 即可使用本阶段的正常对局监控与分析。

