# ClipVault

ClipVault 是一个面向 Windows 的本地优先剪贴板管理器。它将系统单槽剪贴板扩展为可搜索、可分类、可快速粘贴的历史面板，并默认启用敏感内容过滤。

本项目已从 Electron 完整迁移到 Tauri 2：前端继续使用 React 18、TypeScript、Vite、Tailwind 和 Zustand，桌面集成、剪贴板监听、SQLite、全局快捷键、托盘、HUD 与粘贴模拟由 Rust/Tauri 后端负责。

## 核心功能

- 剪贴板历史：文本、图片、文件路径、URL、代码、颜色、邮箱。
- 快速访问：`Ctrl+Shift+V` 打开主面板，`Ctrl+Shift+F` 聚焦搜索。
- 快速粘贴：`Ctrl+Alt+Left/Right` 在历史项之间切换并粘贴。
- 管理能力：搜索、删除、清空、置顶、收藏、类型筛选。
- 桌面集成：系统托盘、暂停/恢复监听、轻量 HUD 反馈、单实例聚焦。
- 隐私保护：本地 SQLite 存储、默认敏感内容过滤、应用黑名单、文件只保存路径和元数据。

## 技术栈

- Tauri 2 + Rust 2021
- React 18 + TypeScript
- Vite + Tailwind CSS
- Zustand
- react-window
- rusqlite + SQLite FTS5
- Vitest + Testing Library

## 环境要求

- Windows 10/11 x64
- Microsoft Edge WebView2 Runtime
- Rust stable + MSVC 构建工具
- Node.js 20+
- pnpm 9+

本仓库已包含 `rust-toolchain.toml`，会固定使用 Rust `stable`，并安装 Windows MSVC 目标 `x86_64-pc-windows-msvc`。

推荐使用根目录脚本启动本地调试：

```powershell
.\start-dev.bat
```

脚本会自动：

- 设置 `RUSTUP_HOME=D:\rj\rustup` 和 `CARGO_HOME=D:\rj\cargo`。
- 指定 `stable-x86_64-pc-windows-msvc` Rust 工具链。
- 检查 `pnpm`、`cargo`、`rustup`。
- 缺少 `node_modules` 时使用 `D:\rj\pnpm-store` 安装依赖。
- 确保 `src-tauri\target\.tauri` 指向 `D:\rj\tauri-tools`。
- 启动 Tauri 桌面调试窗口。
- 结束时暂停窗口，便于查看错误。

只检查环境：

```powershell
.\start-dev.bat check
```

手动安装依赖时必须指定 store：

```powershell
pnpm install --store-dir D:\rj\pnpm-store
```

如果不使用脚本，也可以手动启动完整 Tauri 开发环境：

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
pnpm tauri:dev
```

只启动 Vite 前端开发服务器：

```powershell
pnpm dev
```

`pnpm dev` 不会启动桌面端能力，只适合前端静态调试。

## 验证

```powershell
pnpm typecheck
pnpm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## 构建

生产构建命令：

```powershell
.\start-dev.bat build
```

脚本内部会调用 `pnpm build`。`pnpm build` 等价于 `tauri build`，会先构建 `dist/renderer`，再生成 Windows NSIS 安装包。

主要产物：

- 前端静态资源：`dist/renderer/`
- Release 可执行文件：`src-tauri/target/release/clipvault.exe`
- NSIS 安装包：`src-tauri/target/release/bundle/nsis/ClipVault_0.1.0_x64-setup.exe`

当前配置启用 `bundle.useLocalToolsDir`，Tauri 会优先使用项目 target 下的本地工具目录缓存 NSIS/Wix 等打包工具。若构建机要求工具下载落到固定磁盘，可将 `src-tauri/target/.tauri` 建成指向目标目录的 junction，例如：

```powershell
New-Item -ItemType Directory -Force -Path D:\rj\tauri-tools
New-Item -ItemType Directory -Force -Path src-tauri\target
New-Item -ItemType Junction -Path src-tauri\target\.tauri -Target D:\rj\tauri-tools
```

## 常见问题

### rustup 无法选择 cargo 版本

如果看到：

```text
rustup could not choose a version of cargo to run
```

优先使用：

```powershell
.\start-dev.bat
```

脚本会通过 `rustup run stable-x86_64-pc-windows-msvc cmd /c pnpm tauri:dev` 固定工具链。仓库根目录的 `rust-toolchain.toml` 也会为手动 `cargo` 命令提供项目级工具链选择。

### 启动后只看到 Vite 地址

`http://127.0.0.1:5173/` 是前端开发服务地址。真正测试剪贴板、托盘、全局快捷键和 HUD，需要等待 Tauri 编译完成后自动弹出的桌面窗口。若窗口未出现，可尝试 `Ctrl+Shift+V` 呼出主面板。

### Windows 打包工具下载位置

Tauri 的 NSIS/Wix 工具通过 `bundle.useLocalToolsDir` 缓存在 `src-tauri\target\.tauri`。本机调试时该路径应是指向 `D:\rj\tauri-tools` 的 junction。

## 数据与隐私

- 数据库位置：Tauri `app_data_dir()` 下的 `clipboard.db`。
- 默认保留：普通历史按设置清理，收藏项长期保留。
- 默认过滤：信用卡号、SSN、中国身份证、密码字段、长令牌等敏感内容不会入库。
- 黑名单：可配置应用名或路径，匹配时跳过记录。
- 文件处理：只记录路径和元数据，不复制文件内容。
- 云同步：不实现，数据默认保留在本机。

## 常用快捷键

- `Ctrl+Shift+V`：打开主面板。
- `Ctrl+Shift+F`：打开主面板并聚焦搜索。
- `Ctrl+Shift+P`：暂停或恢复监听。
- `Ctrl+Shift+C`：清空历史。
- `Ctrl+Alt+Left`：快速粘贴上一项。
- `Ctrl+Alt+Right`：快速粘贴下一项。
- 面板内 `ArrowUp/ArrowDown`：移动选择。
- 面板内 `Enter`：粘贴当前项。
- 面板内 `Delete`：删除当前项。
- 面板内 `Ctrl+D`：切换收藏。
- 面板内 `Esc`：隐藏窗口。

## Gitflow 与自动发布

仓库使用轻量 Gitflow：

- `main` 保持可发布状态，推送到 `main` 会触发 GitHub Actions 构建 Windows x64 产物，并上传到本次 Actions run 的 artifacts。
- 日常功能开发建议使用 `feature/*` 分支，稳定后合并回 `main`。
- 准备正式版本时，同时更新 `package.json` 与 `src-tauri/tauri.conf.json` 里的版本号，提交后创建 `vX.Y.Z` 标签。
- 推送 `v*` 标签会自动打包 Windows 安装包并发布 GitHub Release。

发布命令示例：

```powershell
git tag v0.1.1
git push origin v0.1.1
```

当前工作流文件位于 `.github/workflows/release.yml`。Release 由 GitHub Actions 在 `windows-latest` 上执行 `pnpm typecheck`、`pnpm test`、`cargo fmt --check`、`cargo test`、`cargo clippy` 和 Tauri 打包。当前版本未配置代码签名，因此 Windows 首次安装时可能出现系统安全提示。
