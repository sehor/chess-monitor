# 阶段 0 实施状态

更新日期：2026-08-18

## 已完成

- Electron 主进程维护可捕获窗口缓存和唯一授权的窗口 ID；Renderer 只能通过 preload 中的 `capture` API 枚举、选择或清除来源。
- 预览由 Renderer 调用 `getDisplayMedia` 发起，但主进程仅返回当前已选窗口；未选择或来源已失效时拒绝请求。
- 已启用 `contextIsolation`、`nodeIntegration: false`、`sandbox`、受限导航、拒绝新窗口和 CSP。
- 已实现 9×10 共 90 个交叉点的两点标定坐标推导，以及固定正方形 ROI 的帧内边界约束。
- 已实现象棋 FEN 的 10 行、每行 9 路和行棋方字段校验，并定义 `PositionSnapshot`。
- 已锁定 `xiangqiground@0.1.0` 与 `@west-shell/xiangqi.js` 的指定 Git 提交；第三方声明见 [third-party-notices.md](./third-party-notices.md)。

## 验证结果

- `pnpm install --frozen-lockfile`：通过。
- `pnpm smoke`：通过；包括类型检查、10 条 Vitest 测试和生产构建。
- `pnpm audit --audit-level=high`：未执行成功，因为当前 `registry.npmmirror.com` 没有实现 npm audit 接口；在支持 audit 的镜像或官方 registry 上应重新执行。

## 未完成与验收前置条件

- 尚未提供目标象棋客户端的名称、版本、主题、窗口尺寸、DPI 或已标注留出集；因此尚未声明抓屏或 90 点变化检测通过阶段 0 验收。
- 尚未实现像素差分/稳定帧判定、样本持久化、棋盘交互、规则库适配、Pikafish 和 Engine Manager。
- 不读取客户端进程内部数据，也不自动操作客户端。
