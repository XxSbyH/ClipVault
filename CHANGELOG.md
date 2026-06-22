# Changelog

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
