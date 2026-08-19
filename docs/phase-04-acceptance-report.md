# 阶段 4 验收报告：实时 Pikafish 联动

## 结论

阶段 4 的实现与自动化验收已完成。Board Tracker、SQLite、Engine Manager 和 Renderer 现在共享同一条 `positionVersion` 链；任何旧版本或旧 `analysisId` 的输出都不会进入实时 UI。

## 已交付

- `RealtimeCoordinator` 统一处理自动确认、手动确认、撤销、重同步、暂停、恢复和引擎重试。
- SQLite 事务保存未完成棋局、确认着法、当前位置、设置和目标深度的最终分析摘要。
- 持久化失败时回滚到数据库中的最后可信局面、停止分析并进入 `ERROR`/暂停状态。
- Pikafish 使用 ready barrier 隔离旧输出，支持目标深度、MultiPV、红方视角分值、mate、非法 PV 截断和非法 bestmove 过滤。
- 实时界面显示棋盘、版本、红方评估条、最佳着箭头、Top N、PV、深度、节点数，以及独立的跟踪/引擎状态。
- `DESYNC`、暂停和切换局面时立即隐藏不可信 PV 与箭头。
- 应用重开后恢复最后一个未完成棋局及其确认着法。

## 自动化证据

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 10 盘、累计 500 步链路一致 | 通过 | `RealtimeCoordinator` 验收测试使用真实 Board Tracker 观测和 SQLite，逐步比对 Tracker FEN、持久化着法、UI Snapshot 与 Engine 请求 |
| 100 组快速相邻局面，旧结果显示 0 次 | 通过 | Coordinator 与 Engine Manager 各自执行 100 次连续版本切换；断言 UI 只保留当前版本 |
| 新局面可见 P95 < 100 ms | 通过 | 100 次版本发布的 P95 自动断言小于 100 ms |
| Pikafish 首条有效信息 P95 < 2 s | 通过 | 官方 Pikafish 2026-01-02 连续 100 次 ready-barrier 切换，P95 自动断言小于 2 s |
| 强制终止 Pikafish 20 次 | 通过 | 真实子进程连续终止 20 次，每次均恢复并继续分析 positionVersion 1；额外验证自动重启上限与 FAILED 状态 |
| DESYNC 停止分析并标记不可信 | 通过 | 模糊观测进入 DESYNC 后断言引擎停止、`isTrusted=false` |
| 重开恢复未完成棋局 | 通过 | SQLite 关闭重开后恢复 FEN、版本、方向、设置和暂停状态 |
| 仅保存最终摘要 | 通过 | 多条中间 info 后只生成一条目标深度摘要 |
| 无 Python/PyTorch/CUDA 运行依赖 | 通过 | 运行时为 Electron、Vue、Node SQLite 与随附 Pikafish；生产构建成功 |

## 验证命令

```powershell
pnpm test -- --run
pnpm build
pnpm audit --audit-level high --registry=https://registry.npmjs.org
```

当前结果：19 个测试文件、264 项测试全部通过；生产构建通过；未发现已知高危依赖漏洞。

## 界面检查

实时分析面板已在 320、768、1024 和 1440 像素宽度检查，无水平溢出；棋盘、最佳着箭头、评估条和 Top 3 均可见，测试页无 console warning/error。

## 现场验收说明

自动化的 10 盘/500 步使用确定性捕获观测回放，真实 Pikafish 延迟与崩溃恢复使用随仓库引擎执行。发布前仍建议用目标象棋客户端完成一次同规模的人工耐久跑，以覆盖窗口主题、DPI、动画和机器负载等环境变量；该现场记录不影响本阶段代码交付结论。
