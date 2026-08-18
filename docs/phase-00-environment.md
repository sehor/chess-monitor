# 阶段 0：开发环境基线

## 目标

建立与产品路线一致的 Electron、TypeScript、Vue 3 和 Vitest 基线，使后续抓屏 PoC 能在隔离的主进程、preload 与渲染进程边界上实现。

## 命令

- 安装依赖：`pnpm install`
- 开发启动：`pnpm dev`
- 类型检查：`pnpm typecheck`
- 单元测试：`pnpm test --run`
- 生产构建：`pnpm build`
- 冒烟测试：`pnpm smoke`

本地端口约定：后端服务使用 `127.0.0.1:9080`，Vite 前端开发服务使用 `127.0.0.1:9081`。

## 结构

- `electron/`：主进程与受限的 preload API。
- `src/`：Vue 渲染进程和纯 TypeScript 工具。
- `src/**/*.test.ts`：Vitest 单元测试。
- `docs/`：项目与阶段文档。

## 边界

- 始终：启用 `contextIsolation`，渲染进程不直接访问 Node/Electron API。
- 先询问：新增原生模块、数据库、截图后端或 Windows.Graphics.Capture。
- 不做：在本阶段加入棋局识别、Pikafish、持久化或全盘界面。

## 验收

- `pnpm smoke` 通过类型检查、单元测试和 Vite 生产构建。
- `pnpm dev` 能启动一个显示开发环境就绪状态的 Electron 窗口。
