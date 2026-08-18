# 阶段 0–1 实施状态

更新日期：2026-08-18

## 已完成

- Electron 主进程维护可捕获窗口/显示器缓存和唯一授权的来源 ID；Renderer 只能通过 preload 中的 `capture` API 枚举、选择或清除来源。目标窗口源为黑屏时，可选择整屏来源并手动校准棋盘。
- 预览由 Renderer 调用 `getDisplayMedia` 发起，但主进程仅返回当前已选来源；未选择或来源已失效时拒绝请求。
- 已启用 `contextIsolation`、`nodeIntegration: false`、`sandbox`、受限导航、拒绝新窗口和 CSP。
- 已实现 9×10 共 90 个交叉点的两点标定坐标推导，以及固定正方形 ROI 的帧内边界约束。
- 已实现由 Renderer 提供 RGBA 预览帧的大小、格式和坐标校验；主进程仅保留 90 个 ROI 的亮度采样，使用相邻帧差值报告稳定性和变化点数。
- 已实现当前预览帧的安全样本保存；主进程生成随机 PNG 文件名并写入应用数据目录，Renderer 不可指定路径。
- 已实现同名且唯一窗口的重启恢复；来源关闭后 Renderer 最多等待 10 秒，恢复主进程授权并重新启动预览。存在多个同名窗口时拒绝猜测。
- 已把 90 点分析升级为 32×32 灰度 ROI、均值偏移补偿、`0..1` 分数、低/高双阈值和连续三帧稳定判定；采样保持 100 ms 周期且最多一个请求在途，ROI 比例可在 40%–80% 调整。
- 已实现阶段 0 标注采集表单、按对局与 DPI 分组的确定性 70/30 划分、训练集 P99.5/99% 召回阈值推导、留出集 JSON/Markdown 指标报告和失败样本索引。
- 已实现象棋 FEN 的 10 行、每行 9 路和行棋方字段校验，并定义 `PositionSnapshot`；`RulesAdapter` 提供合法走子、执行、撤销、重置、状态和历史，局面 UI 支持合法走子、撤销、重置和方向翻转。
- 已实现独立 `BoardAdapter`，集中处理 `white = red`、方向、ICCS、最后着和最佳着箭头；已建立 50 个 FEN/双方向映射基准。
- 已实现 Pikafish 进程封装、`uci/readyok/info/bestmove` 解析、MultiPV、红方视角评分、64 KiB 行限制、启动与 ready 屏障超时、100 次快速局面切换隔离，以及 250 ms/1 s/2 s 三次崩溃重启。用户通过系统文件选择器选择引擎；主进程只在内存中保存该路径，并在每次启动前校验 SHA-256。
- 阶段 1 UI 已提供 FEN、当前行棋方、撤销/重置、方向、MultiPV 1–5、启动/分析/停止/重启/失败状态、评估、深度、节点、PV、最佳着和箭头。
- 已锁定 `xiangqiground@0.1.0` 与 `@west-shell/xiangqi.js` 的指定 Git 提交；第三方声明见 [third-party-notices.md](./third-party-notices.md)。

## 验证结果

- `pnpm install --frozen-lockfile`：通过。
- `pnpm typecheck`：通过。
- `pnpm test -- --run`：通过；13 个测试文件、230 条 Vitest 测试，其中包含至少 100 个规则适配用例、50 个 FEN 映射、100 次伪引擎切换和 100 次官方 Pikafish 真实切换。
- `pnpm build`：通过；Renderer、Electron 主进程和 preload 均生成生产构建。
- `pnpm smoke`：通过；依次完成类型检查、230 条测试和生产构建。
- `pnpm audit --audit-level=high --registry=https://registry.npmjs.org`：通过，未发现已知漏洞。默认 `registry.npmmirror.com` 不提供 audit 接口，因此审计显式使用官方 registry。

## 现场验收结果与后续

- 目标客户端已确定为 QQ 游戏大厅中的《天天象棋》。首张样本为 1200×936 横屏木纹主题：棋盘在窗口左侧、信息面板在右侧，棋盘九路十线交叉点的截图近似范围为 `(44, 94)` 至 `(665, 790)`。该坐标仅用于建立首个 Profile，不得硬编码为通用坐标。
- 项目方确认阶段 0 现场范围调整为 100%/125% DPI、共 200 个事件且每档至少 80 个，不要求 150%。实采结果为 100% 96 个、125% 104 个；留出集抓帧成功率 100%、最大网格误差 2%、变化点召回率 100%、静止误报率 0，质量门通过。
- 可见的《天天象棋》窗口源仍返回全黑画面；Electron 整屏来源可稳定取得棋盘，因此正式应用已加入整屏来源选择和手动棋盘校准回退。窗口移动后的旧 Profile 批次被识别并剔除，重新校准后复测通过。
- 官方 `2026-01-02` Pikafish BMI2 二进制已在 Intel i5-9400F 设备上完成握手、NNUE 加载、MultiPV、100 次 `stop → ready → position → go`、强制结束恢复和三次失败上限复核；现场故障注入发现并修复了 stdin `EPIPE`。
- Pikafish 可执行文件在 Windows 防火墙真实出站阻断下重复完成真实引擎集成测试；测试退出码 0，临时防火墙规则已删除。完整证据见 `artifacts/field-validation/report.md`、`capture-quality.json` 和 `offline-pikafish.json`。
- 尚未通过应用文件选择器完整走一遍可视 UI；这不影响主进程、规则层、引擎管理器和捕获质量门结果，可作为后续发布前人工检查项。
- 不读取客户端进程内部数据，也不自动操作客户端。
