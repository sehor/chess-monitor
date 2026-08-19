# 阶段 7 实施状态

## 2026-08-19 审查修复

- 窗口来源恢复与实时门禁统一使用 Profile 的 exact/prefix/suffix 声明式匹配规则，避免候选可匹配但实际采集被拒绝。
- 客户端版本兼容范围已参与候选过滤；未提供版本时，不再匹配带版本约束的 Profile；同时拒绝最小版本高于最大版本的输入。
- 保存活动 Profile、回滚、启用/禁用及切换 Profile 时，RecognitionCoordinator、FrameAnalyzer、采集来源和棋局溯源信息保持原子一致；模型准备失败不会提交运行时切换。
- 专用模型导入与激活共用完整校验链：资源目录约束、manifest SHA-256、模型 SHA-256、类别映射及 modelVersion 均需通过。
- Profile Manager 支持编辑现有 Profile 并保留阈值、动画、模型绑定和扩展匹配规则，不再把编辑误保存为新的 shared-model Profile。


## 已实现

- Profile schema v2：客户端/版本、主题、方向、DPI 范围、帧缩放范围、优先级、启用状态、受限窗口匹配规则、阈值、动画规则、模型绑定和 Profile 版本。
- SQLite Profile Manager schema v2：版本历史、复制、禁用/启用、回滚、活动 Profile 管理和 v1 数据迁移。
- 自动匹配只返回候选、排序和原因，首次绑定必须由用户点击确认；禁用 Profile 不参与匹配。
- Profile 编辑器复用现有 90 点 ROI 覆盖层，并增加静态稳定帧噪声采样和 high 阈值建议。
- JSON 导入/导出：外部 JSON 有 512 KiB 上限、schema 校验和字段范围校验；专用模型只接受 recognition 资源目录下的相对 JSON 清单，并校验清单 SHA-256。
- Profile 与模型绑定独立声明；支持 shared 默认模型和 dedicated 模型清单。激活 Profile 时会加载对应清单、校验清单 SHA-256、模型自身 SHA-256 和 modelVersion，再切换 RecognitionCoordinator；失败时不会完成 Profile 激活。
- 新棋局持久化当时的 Profile ID、Profile 版本和识别模型版本；games.sqlite3 schema v1 会迁移到 v2，旧棋局的新增溯源字段保持为空。
- 阶段 3–6 回归已通过现有完整测试集。

## 当前验证结果

- `pnpm smoke`：通过。
- Vitest：23 个测试文件、307 个测试通过。
- TypeScript/Vue 类型检查：通过。
- Vite 客户端、Electron main/preload 生产构建：通过。
- `pnpm audit --audit-level high`：未能执行审计；当前 pnpm registry 指向 npmmirror，其 audit endpoint 不存在。发布前应切换到支持 npm audit API 的 registry 后重试。

## 尚未满足的现场验收项

仓库当前没有两个新增客户端/显著主题各自不少于 500 个标注着法的回放集，因此不能宣称以下验收已完成：

- 至少两个新增客户端或显著视觉差异主题的实测支持。
- 每个新增支持项 ≥ 500 个标注着法。
- 每个新增 Profile 的静默失步数 = 0、确认着法准确率 ≥ 99.9%、正常样本拒绝率 ≤ 1%。
- 支持矩阵内所有客户端/主题/DPI 组合棋盘定位成功率 ≥ 99%。

这些指标必须通过真实客户端采集和回放验证，不能由代码测试替代。

## 新客户端接入清单

1. 记录客户端名称、客户端版本、主题、来源类型（window/screen）和测试 DPI。
2. 选择捕获来源并完成棋盘左上/右下交叉点校准，确认 90 点 ROI 全部在捕获范围内。
3. 保持棋盘静止至少 10 个稳定采样帧，记录 UI 给出的 high 阈值建议。
4. 采集走子、吃子、高亮、动画和静止样本；阈值必须同时通过静止误报和走子召回验证。
5. 为窗口来源使用精确匹配优先；确需 prefix/suffix 时使用足够具体的文本，不得使用过宽子串。
6. 设置客户端/主题/DPI 兼容范围和优先级；新建 Profile 默认需要用户首次确认绑定。
7. 若使用专用 ONNX 模型，将模型和 manifest 放在 recognition 资源目录中，记录 manifest SHA-256 和 modelVersion。
8. 导出 Profile 后执行一次导入往返，确认语义一致并验证损坏/过新 schema/越界路径/哈希不符均被拒绝。
9. 使用同一 Board Tracker 回放框架跑不少于 500 个标注着法；记录静默失步、准确率、拒绝率和棋盘定位成功率。
10. 跑 `pnpm smoke`，确认阶段 3–6 的既有回归继续通过。
11. 至少选一个新增支持项仅通过 Profile/资源接入；若必须修改 Board Tracker 核心，先记录字段/接口缺口和完整回归证据。

## 兼容矩阵模板

| 客户端 | 版本 | 主题 | 来源 | DPI | Profile 版本 | 模型版本 | 标注着法 | 静默失步 | 准确率 | 拒绝率 | 定位成功率 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 待实测 A | 待填写 | 待填写 | window/screen | 100/125/150 | 待填写 | shared/dedicated | 0 | - | - | - | - | 待验证 |
| 待实测 B | 待填写 | 待填写 | window/screen | 100/125/150 | 待填写 | shared/dedicated | 0 | - | - | - | - | 待验证 |
