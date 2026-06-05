# ClipVault Tauri 2 迁移验证记录

日期：2026-06-05
分支：`feat/tauri2-migration-impl`
目标：验证 Electron 到 Tauri 2 的完整迁移、打包产物和体积收益。

## 构建环境

- 操作系统：Windows
- 前端：React 18 + TypeScript + Vite
- 桌面端：Tauri 2 + Rust
- Rust/Cargo 路径：`D:\rj\rustup`、`D:\rj\cargo`
- pnpm store：`D:\rj\pnpm-store`
- Tauri 本地工具目录：`src-tauri\target\.tauri` junction 到 `D:\rj\tauri-tools`
- NSIS 工具验证：`D:\rj\tauri-tools\NSIS\Bin\makensis.exe` 存在

## 自动化验证

| 命令 | 结果 | 摘要 |
| --- | --- | --- |
| `pnpm typecheck` | PASS | `tsc -p tsconfig.web.json --noEmit` 退出码 0 |
| `pnpm test` | PASS | 3 个测试文件，19 个测试通过 |
| `cargo fmt --manifest-path src-tauri\Cargo.toml --check` | PASS | 退出码 0 |
| `cargo test --manifest-path src-tauri\Cargo.toml` | PASS | 90 个 Rust 测试通过 |
| `cargo clippy --manifest-path src-tauri\Cargo.toml -- -D warnings` | PASS | 退出码 0 |
| `pnpm build` | PASS | 生成 release 可执行文件与 NSIS 安装包 |
| `pnpm tauri build` | PASS | 显式 Tauri 打包通过 |

备注：

- 首次未配置 `bundle.useLocalToolsDir` 时，Tauri 将 NSIS 缓存写入了 `C:\Users\Administrator\AppData\Local\tauri` 并出现过一次解压权限错误。
- 已启用 `bundle.useLocalToolsDir`，并将 `src-tauri\target\.tauri` 建为指向 `D:\rj\tauri-tools` 的 junction。
- 重新打包后确认 `C:\Users\Administrator\AppData\Local\tauri` 未被重建。
- 误落到 C 盘的 Tauri 缓存已移动到 `D:\rj\tauri-moved-appdata-cache\tauri-20260605-200533`。
- 最终 `pnpm build` 日志未出现下载步骤，直接使用 `D:\rj\tauri-tools` 下的 NSIS 工具。

## 体积对比

Electron 基线来自清理旧产物前的 `dist/win-unpacked` 测量：

- Electron unpacked：390,318,482 字节，约 390.3 MB。

Tauri 迁移后最终测量：

- `dist/renderer`：275,339 字节，7 个文件。
- `src-tauri\target\release\clipvault.exe`：14,288,384 字节。
- `src-tauri\target\release\bundle\nsis\ClipVault_0.1.0_x64-setup.exe`：3,602,546 字节。

最大 Tauri bundle 文件：

| 文件 | 字节 |
| --- | ---: |
| `src-tauri\target\release\bundle\nsis\ClipVault_0.1.0_x64-setup.exe` | 3,602,546 |

最大 renderer 文件：

| 文件 | 字节 |
| --- | ---: |
| `dist\renderer\assets\index-BJXaZuw9.js` | 239,498 |
| `dist\renderer\assets\index-DXvIpn72.css` | 28,031 |
| `dist\renderer\assets\tauriApi-DVGQQjpL.js` | 4,497 |
| `dist\renderer\assets\hud-CMnAhnl2.css` | 1,456 |
| `dist\renderer\hud.html` | 707 |
| `dist\renderer\assets\hud-DqFxJ9CR.js` | 643 |
| `dist\renderer\index.html` | 507 |

## 手工 Windows 检查清单

本轮未执行完整人工交互验证。原因：以下项目需要真实 Windows 桌面交互、系统剪贴板、托盘菜单、全局快捷键和目标应用焦点配合，不能仅凭自动化测试可靠确认。

待人工验证：

- 文本复制 1 秒内出现在历史列表。
- 图片复制后出现缩略图和详情预览。
- 文件路径只保存路径与元数据。
- 敏感内容样本不会入库。
- 黑名单应用复制内容不会入库。
- `Ctrl+Shift+V` 打开或隐藏主面板。
- `Ctrl+Shift+F` 聚焦搜索。
- `Ctrl+Shift+P` 暂停或恢复监听，托盘状态同步更新。
- `Ctrl+Shift+C` 清空非收藏历史。
- `Ctrl+Alt+Left/Right` 快速粘贴并显示 HUD。
- 启用滚轮快捷键后，滚轮快捷粘贴生效且按规则消费事件。
- 托盘菜单打开、暂停、清空、设置、退出可用。
- 开机自启动设置持久化。
- 第二实例启动时聚焦既有窗口。

## 风险与后续

- `identifier` 仍为 `com.clipvault.app`，Tauri 构建会提示 macOS `.app` 后缀警告；当前目标平台是 Windows，不影响 NSIS 构建。
- Tauri NSIS 工具下载位置依赖 `bundle.useLocalToolsDir` 与本机 junction；若重建 target 目录，需要重新创建 `src-tauri\target\.tauri -> D:\rj\tauri-tools`。
- 手工 Windows checklist 需要在真实桌面会话中补跑。
