# ClipVault Tauri 2 完整迁移设计 Spec

**Status:** Approved for planning  
**Date:** 2026-06-05  
**Owner:** xxsby  
**Scope:** 将现有 Electron 版 ClipVault 一次性迁移为 Tauri 2 体系，并同步优化主 UI。

## 1. 背景

当前 ClipVault 使用 Electron + React + TypeScript。现有功能已经覆盖剪贴板监听、SQLite 存储、搜索、图片处理、全局快捷键、快速粘贴、HUD、托盘、设置、隐私过滤和黑名单。问题是 Electron 打包体积过大，本地 `dist/win-unpacked` 约 390MB，其中体积主要来自 Electron/Chromium 运行时、locale、GPU/ffmpeg 相关文件，以及 `sharp`、`better-sqlite3`、`uiohook-napi` 等原生 Node 依赖。

目标是完全迁移到 Tauri 2，不保留 Electron 运行时，不使用 Node sidecar，不降低核心功能完整性。前端可以保留 React 技术栈，但必须从 `window.electron` IPC 模型切换到 Tauri command/event 模型。

官方能力依据：

- Tauri 2 clipboard plugin: <https://v2.tauri.app/plugin/clipboard/>
- Tauri 2 global shortcut plugin: <https://v2.tauri.app/plugin/global-shortcut/>
- Tauri 2 system tray: <https://v2.tauri.app/learn/system-tray/>
- Tauri 2 autostart plugin: <https://v2.tauri.app/plugin/autostart/>
- Tauri 2 single instance plugin: <https://v2.tauri.app/plugin/single-instance/>
- Tauri 2 Windows installer: <https://v2.tauri.app/distribute/windows-installer/>

## 2. 决策

采用 **Tauri 2 + Rust 后端 + React 前端** 的重构方案。

核心决策：

- 删除 Electron 主进程、preload、electron-vite、electron-builder。
- 新增 `src-tauri`，由 Rust 统一管理系统能力、数据库、剪贴板、热键、托盘、窗口、HUD 和隐私逻辑。
- React/Vite/Tailwind/shadcn UI 保留并重构，前端只通过 Tauri `invoke` 和 `listen` 与后端交互。
- 不把数据库、文件系统、剪贴板等敏感能力直接暴露给前端。
- 保留当前数据库语义和用户数据，迁移时优先复用/迁移旧 `clipboard.db`。
- Windows 为首要平台；跨平台兼容不作为本阶段目标，但模块边界应避免不必要的 Windows 逻辑泄漏到 UI。

## 3. 非目标

本迁移不实现以下功能：

- 云同步。
- 图片 OCR。
- 团队协作。
- 文件内容复制。
- 视频播放。
- Electron fallback。
- Node sidecar。
- 重新定义产品核心工作流。

## 4. 功能一一对应要求

| Electron 现有能力 | Tauri 2 / Rust 实现要求 |
|---|---|
| 文本剪贴板监听 | Rust 轮询任务读取剪贴板文本，保留去重、大小限制、敏感过滤、黑名单检查 |
| 图片剪贴板监听 | Rust 读取图片剪贴板数据，压缩后写入 SQLite BLOB |
| 文件路径检测 | Rust detector 复刻 Windows 路径规则，仅存路径和元数据 |
| URL/code/color/email/text 分类 | Rust detector 复刻现有规则，必要时补充单元测试锁定行为 |
| 敏感内容过滤 | Rust privacy 模块默认开启，保留信用卡、SSN、中国身份证、疑似 token、password 字段规则 |
| 应用黑名单 | Rust Windows API 查询前台进程，替代 PowerShell 脚本 |
| SQLite 历史 | Rust `rusqlite` 管理本地 SQLite，保留表结构和索引语义 |
| FTS 搜索 | SQLite FTS5 为主；必要时 Rust 模糊匹配作为补充 |
| MiniSearch 内存索引 | 不保留 MiniSearch，避免额外 JS 索引状态；搜索统一由 Rust/SQLite 提供 |
| 置顶/收藏/删除/清空 | Rust commands 实现，返回更新后的 `ClipboardItem` 或操作结果 |
| 设置读写 | Rust settings repository 操作 `settings` 表 |
| 快捷键设置和冲突检测 | Rust 注册/注销快捷键；前端提供冲突反馈 |
| Ctrl+Shift+V 打开面板 | Tauri global-shortcut 控制主窗口显示/隐藏 |
| Ctrl+Shift+F 聚焦搜索 | 后端显示主窗口并向前端发事件 |
| Ctrl+Shift+P 暂停监听 | 后端切换监听状态并刷新托盘 |
| Ctrl+Shift+C 清空历史 | 后端执行清空，前端显示结果 |
| Ctrl+Alt+←/→ 快速粘贴 | 后端移动历史游标、写系统剪贴板、发送粘贴动作、显示 HUD |
| 滚轮快速切换 | Windows 低级鼠标 hook 实现现有滚轮设置能力 |
| 点击条目粘贴 | 前端 invoke `paste_item`，后端写剪贴板并模拟粘贴 |
| HUD | 独立透明置顶非聚焦 Tauri window，展示方向、类型、预览文本 |
| 托盘 | Tauri tray，支持打开、暂停/恢复、清空历史、设置、退出 |
| 暂停托盘图标 | 保留 active/paused 两套资源并动态切换 |
| 开机自启动 | Tauri autostart plugin |
| 单实例 | Tauri single-instance plugin |
| 日志 | Rust tracing/log 文件输出到用户数据目录 |
| 自动清理 | Rust 定时任务按保留天数清理非收藏项 |

## 5. 架构设计

### 5.1 后端模块

`src-tauri/src` 按职责拆分：

- `main.rs`: Tauri builder、插件注册、状态注入、窗口/托盘初始化。
- `commands.rs`: 对前端暴露的 command 聚合层，保持薄封装。
- `events.rs`: 后端向前端发事件的统一通道名称和 payload。
- `models.rs`: `ClipboardItem`、`AppSettings`、`HotkeySettings`、`BlacklistApp` 等序列化模型。
- `database/`: schema、migration、repository、transaction 和旧库迁移。
- `clipboard/`: 监听循环、文本/图片捕获、去重、图片处理、文件路径元数据。
- `detector.rs`: 内容类型检测和预览生成。
- `privacy/`: 敏感内容规则和前台应用黑名单判断。
- `hotkeys/`: 全局快捷键、快速粘贴游标、滚轮 hook。
- `paste/`: 写剪贴板和 Windows `SendInput` 粘贴动作。
- `tray.rs`: 托盘图标、菜单和状态刷新。
- `windows.rs`: 主窗口、HUD 窗口创建和显示策略。
- `settings.rs`: 设置读取、更新和变更副作用。
- `cleanup.rs`: 启动清理和周期清理任务。
- `logger.rs`: 文件日志初始化。

### 5.2 前端模块

保留 `src/renderer/src`，但迁移 API 层：

- 新增 `src/renderer/src/lib/tauriApi.ts`，封装所有 `invoke` 和 `listen`。
- 删除 `window.electron` 依赖和 preload 类型。
- Zustand store 保留，但数据加载改为 Tauri API。
- 列表继续使用虚拟滚动，保证 1000+ 项性能。
- 设置面板保留功能项，但视觉和交互重构。
- HUD 页面保留独立入口，适配 Tauri 事件 payload。

### 5.3 通信约定

前端只能使用以下两类通信：

- Commands: `get_history`、`search_items`、`paste_item`、`delete_item`、`toggle_pin`、`toggle_favorite`、`get_image_data_url`、`get_settings`、`update_setting`、`get_hotkeys`、`update_hotkeys`、`check_hotkey_conflicts`、`clear_history`、`toggle_monitoring`、`list_blacklist`、`add_blacklist`、`remove_blacklist`、`test_monitoring`、`test_hud`、`minimize_window`、`hide_window`。
- Events: `clipboard:new-item`、`clipboard:focus-search`、`clipboard:open-settings`、`clipboard:open-hotkeys`、`hud:show`、`history:revision`、`monitoring:changed`。

事件名称尽量沿用现有命名，降低前端改造范围。

## 6. UI/UX 设计

确认方向：**A 作为主面板，吸收 B 的详情预览和 C 的 HUD 轻量反馈。**

主面板设计：

- 结构为命令面板式单列。
- 顶部为搜索框，强调键盘入口和当前快捷键提示。
- 搜索框下方为类型筛选：全部、文本、图片、代码、URL、收藏。
- 中部为虚拟列表，每项展示类型、预览、时间、元数据、置顶/收藏/删除操作。
- 选中项提供轻量详情预览，不默认占用双栏宽度；长文本/代码/图片可打开详情弹层。
- 底部或状态区显示监听状态、数据量、当前快捷键提示。

HUD 设计：

- 小型透明置顶浮层。
- 不抢焦点，不接收鼠标事件。
- 展示快速粘贴方向、类型、短预览。
- 连续切换时延长显示时间。

视觉基调：

- 优雅、简洁、低干扰，避免复杂装饰。
- 主色采用 teal，关键动作采用 orange 点缀。
- 使用 Lucide 图标，不使用 emoji 作为 UI 图标。
- 保持清晰键盘焦点，所有可点击项有 hover 和 focus 状态。
- 支持 520px 最小宽度，桌面默认窗口约 600x800。

可访问性：

- 列表项可键盘导航。
- `Enter` 粘贴并关闭面板。
- `Delete` 删除。
- `Ctrl+D` 切换收藏。
- `Ctrl+F` 聚焦搜索。
- `Esc` 隐藏面板。
- 所有交互控件有明确 label 或 title。
- 动画遵守 `prefers-reduced-motion`。

## 7. 数据兼容和迁移

旧 Electron 数据位置：

- 默认读取旧应用数据目录中的 `clipboard.db`。
- Tauri 版启动时检测新库是否存在。
- 若新库不存在且旧库存在，则先备份旧库，再复制或迁移到 Tauri 用户数据目录。
- 迁移过程不得删除旧库。

兼容要求：

- 保留 `clipboard_items`、`settings`、`app_blacklist` 和 FTS 语义。
- 保留 `is_pinned`、`is_favorite`、`use_count`、`last_used_at`。
- 保留图片 BLOB。
- 对缺失字段执行 migration。
- 对损坏 FTS 结构执行重建。

失败处理：

- 迁移失败时保留备份。
- 应用仍可启动并创建新库。
- UI 显示用户友好的错误信息。
- 详细错误写入日志。

## 8. 安全与隐私

默认隐私策略不降低：

- 敏感内容过滤默认开启。
- 应用黑名单默认开启。
- 数据仅本地存储。
- 前端不直接访问数据库文件。
- 前端不直接读系统剪贴板。
- Command 参数必须校验。
- 文件路径只读元数据，不读取文件内容。

Windows API 使用约束：

- 前台进程查询只用于黑名单判断。
- 粘贴模拟只在用户触发快捷键或点击粘贴时执行。
- 低级鼠标 hook 只处理已启用的滚轮快捷键配置。

## 9. 打包与体积策略

打包目标：

- Windows installer 为主要产物。
- 默认不内置 WebView2 runtime，以减小安装包体积。
- 若用户环境缺少 WebView2，由安装器/bootstrapper 处理。
- 不引入 Electron、Chromium、Node runtime。

体积验收：

- 迁移后 `src-tauri/target/release/bundle` 产物应明显小于当前 Electron 版本。
- 记录最终 installer 和 unpacked 体积。
- 若引入图片处理 crate 导致体积明显膨胀，应优先优化功能实现，而不是牺牲功能。

## 10. 测试策略

Rust 单元测试：

- 内容类型检测。
- 敏感内容过滤。
- SQLite repository CRUD。
- FTS 搜索和 fallback。
- 设置解析和更新。
- 快捷键配置解析。
- 快速粘贴游标移动。
- 清理策略。

Rust 集成测试：

- migration 创建 schema。
- 旧库迁移。
- 插入重复内容去重。
- 删除后 FTS 一致性。

前端测试：

- Tauri API 封装。
- 列表筛选。
- 搜索状态。
- 置顶/收藏/删除交互。
- 设置面板保存。
- 键盘导航。

手工验收：

- 文本复制后 1 秒内出现在列表。
- 图片复制后出现在列表并可预览。
- 文件路径只保存路径和元数据。
- 敏感内容不被记录。
- 黑名单前台应用不被记录。
- `Ctrl+Shift+V` 打开/隐藏面板。
- `Ctrl+Shift+F` 打开面板并聚焦搜索。
- `Ctrl+Shift+P` 暂停/恢复监听，托盘状态同步。
- `Ctrl+Shift+C` 清空非收藏历史。
- `Ctrl+Alt+Left/Right` 快速粘贴正确项目并显示 HUD。
- 滚轮快捷键按设置生效。
- 托盘菜单所有功能可用。
- 开机自启动设置可保存。
- 单实例启动时聚焦已有窗口。
- 构建产物可安装、启动、退出、卸载。

必跑命令：

- `pnpm typecheck`
- `pnpm test` 或项目新增的前端测试命令
- `cargo test`
- `cargo clippy -- -D warnings`
- `cargo fmt --check`
- `pnpm tauri build`

## 11. 迁移顺序

实施计划应按以下顺序拆分：

1. 建立 Tauri 2 工程骨架和构建链路。
2. 建立 Rust 模型、数据库、migration 和旧库兼容。
3. 建立 Tauri command/event API。
4. 迁移前端 API 适配层，移除 Electron preload 依赖。
5. 迁移剪贴板监听、隐私过滤、内容检测和图片处理。
6. 迁移搜索、历史操作、设置、黑名单。
7. 迁移窗口、托盘、自启动、单实例。
8. 迁移快捷键、快速粘贴、滚轮 hook 和 HUD。
9. 重构主 UI 为确认的命令面板式单列方案。
10. 清理 Electron 依赖、配置和构建产物。
11. 完整测试和 Windows 打包验证。

## 12. 风险和应对

| 风险 | 应对 |
|---|---|
| 滚轮全局 hook 没有现成 Tauri 插件完全覆盖 | 使用 Windows 低级鼠标 hook，封装在 `hotkeys` 模块 |
| 图片剪贴板格式差异 | 先支持 PNG/bitmap 常见路径，失败时记录日志并跳过 |
| WebView2 环境缺失 | 使用 Tauri Windows installer 推荐机制，不默认内置大体积 runtime |
| 旧 SQLite/FTS 损坏 | 迁移前备份，失败时重建 FTS，不删除旧库 |
| 快捷键被系统占用 | 注册失败返回冲突信息，UI 引导用户修改 |
| PowerShell SendKeys 替换风险 | 使用 Windows `SendInput`，加延迟和错误日志 |
| 一次性迁移范围大 | 执行计划分任务提交，每个任务有测试和回归点 |

## 13. 完成定义

迁移完成必须满足：

- Electron 运行时和打包链路已移除。
- 应用通过 Tauri 2 构建并可在 Windows 安装运行。
- AGENTS.md 中列出的核心功能全部可用。
- 旧数据可迁移或复用，不丢失收藏/置顶/设置。
- UI 使用确认的 A+B+C 混合方向。
- 自动化测试和手工验收通过。
- 打包体积明显低于当前 Electron 版本。
- 无控制台错误和未处理 panic。
- 关键错误写入日志，UI 展示友好错误。
