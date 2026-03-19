# ClipVault

ClipVault 是一个基于 Electron + React + TypeScript 的 Windows 智能剪贴板管理器。  
它将系统单条剪贴板扩展为可持久化、可搜索、可分类的历史面板，并支持全局快捷键快速粘贴。

## 功能简介

- 剪贴板历史记录（文本、图片、URL、代码等）
- 全局快捷键呼出面板与快速粘贴
- 收藏/置顶/删除管理
- 本地 SQLite 存储与全文搜索
- 系统托盘运行（暂停/恢复监听）
- 设置面板（保留策略、隐私、存储、快捷键）

## 技术栈

- Electron
- React 18 + TypeScript
- Vite（electron-vite）
- Zustand
- better-sqlite3
- MiniSearch
- sharp
- uiohook-napi

## 环境要求

- Windows 10/11（x64）
- Node.js 20+（建议 LTS）
- pnpm 9+

> 本项目含原生依赖（`better-sqlite3`、`sharp`、`uiohook-napi`），请确保本机网络与构建环境正常。

## 快速开始（开发）

```bash
pnpm install
pnpm run dev
```

启动后会打开 Electron 应用窗口。

## 常用命令

```bash
# 类型检查
pnpm run typecheck

# 生产打包（安装包）
pnpm run build

# 生产打包（目录版，不生成安装向导）
pnpm run build:dir

# 预览（构建后）
pnpm run preview
```

## 打包产物说明

### 1) 目录版（推荐联调）

执行：

```bash
pnpm run build:dir
```

输出目录：

- `dist/win-unpacked/ClipVault.exe`

适合直接运行验证，不经过安装流程。

### 2) 安装包版（推荐发布）

执行：

```bash
pnpm run build
```

输出目录：

- `dist/`（包含 NSIS 安装包）

安装后可通过开始菜单/桌面快捷方式启动。

## 部署教程（生产环境）

### 方式 A：分发安装包（推荐）

1. 在构建机执行 `pnpm run build`
2. 将 `dist` 内生成的安装包分发到目标机器
3. 目标机器双击安装并启动

### 方式 B：分发目录版（免安装）

1. 在构建机执行 `pnpm run build:dir`
2. 打包并分发 `dist/win-unpacked` 整个目录
3. 在目标机器运行 `ClipVault.exe`

## 图标与资源

- 应用图标：`resources/icon.ico`
- 托盘图标：
  - `resources/tray-icon.png`
  - `resources/tray-icon@2x.png`
  - `resources/tray-icon-paused.png`
  - `resources/tray-icon-paused@2x.png`

`electron-builder.yml` 已配置统一使用 `resources/icon.ico` 作为 Windows 应用图标。

## 数据与日志位置（Windows）

- 数据库：`%APPDATA%/clipvault/clipboard.db`
- 日志：`%APPDATA%/clipvault/logs/`

## 常见问题

### 1) 打包失败：`Access is denied`（win-unpacked 文件被占用）

原因：`ClipVault.exe` 正在运行，导致覆盖失败。  
处理：先关闭应用进程，再重新执行打包命令。

### 2) 原生模块相关错误（sharp / better-sqlite3 / uiohook-napi）

先执行：

```bash
pnpm install --force
pnpm run build:dir
```

仍有问题时，确认 Node 版本与系统架构（x64）一致。
