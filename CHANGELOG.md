# Changelog

## v2.1.7 - 2026-06-27

### 更新内容

- 支持新版本安装包直接覆盖安装，升级前退出正在运行的 ClipVault 后运行 `ClipVault_*_windows_x64_setup.exe` 即可。
- 修复全局热键被其它应用占用时可能影响启动的问题；启动阶段会保留可用热键并记录不可用项。
- 修复设置页修改热键时被无关旧占用项阻断的问题；只有本次正在修改的快捷键不可用时才阻止保存。
- 修复应用黑名单来源识别问题；从黑名单应用复制后，即使马上切换到普通应用，同一次剪贴板变更也不会被补录。
- 校正历史快速复制文案和行为说明，明确 `Ctrl+Alt+Left/Right` 是复制历史项到剪贴板。
- 新增用户向功能文档 `docs/FEATURES.md`，补充隐私、黑名单、快捷键、导入导出和当前边界说明。

### 发布文件

- `ClipVault_*_windows_x64_setup.exe`：Windows x64 安装包，推荐大多数 Windows 用户覆盖安装使用。
- `ClipVault_*_windows_x64_portable.exe`：Windows x64 便携版，适合免安装或临时运行。

## v2.1.3 - 2026-06-22

### 更新内容

- 将最大历史条目数默认值调整为 10000。
- 修复修改最大历史条目数时可能清空已有历史记录的问题。
- 修复最大历史条目数输入 1000000 后失焦回退为 10000 的问题。
- 支持将 Ctrl+X 剪切后的剪贴板内容写入历史记录。

### 验证

- `pnpm typecheck`
- `pnpm test`
- `cargo fmt --manifest-path src-tauri\Cargo.toml --check`
- `cargo test --manifest-path src-tauri\Cargo.toml`
- `cargo clippy --manifest-path src-tauri\Cargo.toml -- -D warnings`
- `pnpm build`
