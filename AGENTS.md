# ClipVault AGENTS.md

## 适用范围

本文件是仓库根目录的代理指令文件，适用于在本仓库内工作的 Codex 和其他编码代理。写法遵循官方 Codex 对 `AGENTS.md` 的建议：只放长期有效的项目规范、启动命令、验证步骤和协作规则。若某个子目录需要不同规则，再在该子目录放置更近的 `AGENTS.md` 或 `AGENTS.override.md`。

## 沟通规则

- 必须始终称呼项目所有者为 `xxsby`。
- 必须始终使用中文与 xxsby 沟通。
- 技术说明保持直接、具体、可执行。
- 生成或修改的源码、配置、文档和脚本必须是 UTF-8 无 BOM。

## 项目定位

ClipVault 是一个面向 Windows 的本地优先剪贴板管理器。它把系统单槽剪贴板扩展为可搜索、可分类、可持久化的历史记录，并支持快速粘贴、系统托盘、HUD 反馈、隐私过滤和本地存储。

核心产品约束：

- 重构时必须一一保留剪贴板管理器核心功能。
- 默认本地存储，不添加云同步。
- 不实现 OCR、团队协作、视频播放、文件内容复制。
- 文件类型只保存路径和元数据。
- 隐私过滤和应用黑名单属于核心功能，不是可选增强。

## 当前架构

本项目已从 Electron 完整迁移到 Tauri 2。

前端：

- React 18 + TypeScript。
- Vite。
- Tailwind CSS。
- Zustand。
- react-window。
- Vitest + Testing Library。

桌面端/后端：

- Tauri 2 + Rust 2021。
- SQLite 使用 `rusqlite`，启用 FTS5。
- 使用 Tauri 剪贴板、全局快捷键、自启动、单实例插件。
- Windows 桌面集成包含粘贴模拟、系统托盘、前台应用检测、热键、滚轮 hook 和 HUD。

重要目录：

- `src/renderer/src`：React 渲染层。
- `src/shared`：共享 TypeScript 类型。
- `src-tauri/src`：Rust 后端和 Tauri commands。
- `src-tauri/capabilities`：Tauri 权限配置。
- `resources`：Windows 和托盘图标资源。
- `docs/superpowers/specs`：迁移和设计规格。
- `docs/superpowers/plans`：实施计划。
- `docs/superpowers/verification`：验证记录。

已移除的旧架构：

- 不再有 Electron runtime。
- 不再有 Electron main/preload 进程。
- 不再使用 `electron-builder`、`electron-vite`、`better-sqlite3`、`sharp`、`uiohook-napi`、`MiniSearch` 或 `crypto-js` 作为运行时依赖。
- 不允许重新引入 Electron fallback 或 Node sidecar。

## 本地环境

本项目按 xxsby 的本地 Windows 环境配置。

必要工具：

- Windows 10/11 x64。
- Microsoft Edge WebView2 Runtime。
- Node.js 20+。
- pnpm 9+。
- Rust stable MSVC 工具链。

本地存储约束：

- 任何需要自定义路径的依赖缓存、Rust 工具链、Tauri 工具下载或临时构建缓存，都必须使用 `D:\rj`。
- pnpm 安装使用 `D:\rj\pnpm-store`。
- Rust 使用 `D:\rj\rustup` 和 `D:\rj\cargo`。
- Tauri 本地打包工具使用 `D:\rj\tauri-tools`，通过 `src-tauri\target\.tauri` junction 指向该目录。

仓库已包含：

- `start-dev.bat`：本地调试和构建脚本。
- `rust-toolchain.toml`：固定 `stable-x86_64-pc-windows-msvc`。

## 常用命令

推荐本地调试：

```powershell
.\start-dev.bat
```

环境检查：

```powershell
.\start-dev.bat check
```

构建安装包：

```powershell
.\start-dev.bat build
```

手动安装依赖：

```powershell
pnpm install --store-dir D:\rj\pnpm-store
```

手动启动开发环境：

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
pnpm tauri:dev
```

手动生产构建：

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
pnpm build
```

构建产物：

- `dist/renderer/`
- `src-tauri/target/release/clipvault.exe`
- `src-tauri/target/release/bundle/nsis/ClipVault_0.1.0_x64-setup.exe`

## 验证要求

声明任务完成前，必须运行与改动范围匹配的验证命令。涉及架构、打包、核心功能或发布风险的改动，运行完整验证：

```powershell
pnpm typecheck
pnpm test
cargo fmt --manifest-path src-tauri\Cargo.toml --check
cargo test --manifest-path src-tauri\Cargo.toml
cargo clippy --manifest-path src-tauri\Cargo.toml -- -D warnings
pnpm build
```

运行 Rust 命令前设置：

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
```

以下桌面行为需要真实 Windows 会话人工验证，不能只靠自动化测试声明完成：

- 文本复制进入历史记录。
- 图片复制后能预览。
- 文件路径只保存路径和元数据。
- 敏感内容被跳过。
- 黑名单应用被跳过。
- `Ctrl+Shift+V`、`Ctrl+Shift+F`、`Ctrl+Shift+P`、`Ctrl+Shift+C`、`Ctrl+Alt+Left/Right` 行为正确。
- 启用滚轮快捷键后行为正确。
- 托盘菜单可用。
- HUD 能显示轻量反馈。
- 自启动设置能持久化。
- 第二实例启动时聚焦已有窗口。

## 开发规则

- 搜索文件或文本优先使用 `rg`。
- 手动编辑文件必须使用 `apply_patch`。
- 不要回滚用户改动，除非 xxsby 明确要求。
- 不要使用 `git reset --hard`、`git checkout --` 等破坏性命令，除非明确获批。
- TypeScript 保持 strict，不随意使用 `any`。
- Rust 代码保持 `cargo fmt` 格式。
- Tauri command 和事件名保持稳定；若必须变更，前后端必须同步。
- 行为变更需要新增或更新测试。
- 避免无必要的新依赖。
- 命令因沙箱、权限或网络失败时，按权限规则申请批准后重跑，不要绕过约束。

## Tauri 与 Rust 规则

- Tauri commands 位于 `src-tauri/src/commands.rs`。
- 共享 Rust model 位于 `src-tauri/src/models.rs`，面向前端的字段保持 camelCase 序列化。
- SQLite schema 和 migrations 位于 `src-tauri/src/database`。
- 剪贴板捕获逻辑位于 `src-tauri/src/clipboard`。
- 桌面集成逻辑位于 `hotkeys.rs`、`paste.rs`、`tray.rs`、`windows.rs` 和 `privacy/foreground.rs`。
- Tauri 权限必须在 `src-tauri/capabilities` 和 `src-tauri/permissions` 中显式维护。
- 设置更新若依赖运行时注册步骤，必须先验证运行时步骤成功，避免部分持久化。
- 非 Windows 环境无法支持的行为，应返回清晰的 unsupported 错误。

## 前端规则

- 渲染层只通过 `src/renderer/src/lib/tauriApi.ts` 与 Rust 通信。
- 不使用 `window.electron` 或任何 Electron API。
- 保持已确认的 UI 基线：命令面板主界面、详情预览、轻量 HUD 反馈。
- 保持键盘优先。
- 大列表保持虚拟滚动。
- 使用 Lucide 图标和当前 teal/orange 视觉语言，除非 xxsby 明确要求重新设计。
- 键盘行为、设置更新、API adapter 行为需要组件测试覆盖。

## 数据与隐私规则

默认数据行为：

- 文本在配置限制内保存并可搜索。
- 图片按尺寸规则压缩后保存。
- 文件只保存路径和元数据。
- 收藏项在清理时保留。
- 非收藏旧项按保留天数和最大条数清理。

必须跳过的敏感内容：

- 疑似信用卡号。
- 美国 SSN 类格式。
- 中国身份证号。
- 密码赋值。
- 长大写字母数字 token/API key 类内容。

黑名单行为：

- 应用名和规范化路径大小写不敏感匹配。
- 内置黑名单记录必须防止误删。

## Git 工作流

- 只有 xxsby 要求直接集成时，才在 `main` 上工作。
- 其它情况使用功能分支。
- 提交必须聚焦、信息简洁。
- 不要 amend commit，除非明确要求。
- 重大工作完成后报告验证证据和未完成的人工验证风险。

## 文档规则

- `README.md` 面向用户：安装、启动、调试、构建、验证、常见问题和隐私行为。
- `AGENTS.md` 面向代理：长期开发规范、架构、命令和验证要求。
- 大型迁移或发布级验证记录放在 `docs/superpowers/verification`。
