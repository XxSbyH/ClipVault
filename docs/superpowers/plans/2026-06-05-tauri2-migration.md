# ClipVault Tauri 2 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fully migrate ClipVault from Electron to Tauri 2 while preserving all core clipboard-manager functionality and redesigning the UI around the approved command-panel layout.

**Architecture:** React/Vite/Tailwind remains the renderer. Electron main/preload is replaced by a Rust `src-tauri` backend that owns clipboard access, SQLite, hotkeys, tray, windows, HUD, privacy filtering, and paste simulation. The renderer communicates only through Tauri commands/events via a typed API wrapper.

**Tech Stack:** Tauri 2, Rust 2021, rusqlite, serde, tokio, tauri-plugin-clipboard-manager, tauri-plugin-global-shortcut, tauri-plugin-autostart, tauri-plugin-single-instance, React 18, TypeScript, Vite, Tailwind, Zustand, react-window, Vitest.

---

## Spec And Constraints

Read first:

- `docs/superpowers/specs/2026-06-05-tauri2-migration-design.md`
- `AGENTS.md`

Hard constraints:

- Reply and notes for xxsby must be in Chinese.
- Generated source/config files must be UTF-8 without BOM.
- No Electron fallback, no Node sidecar.
- Keep core features one-to-one with the spec.
- Use TDD for behavior modules and API adapters.
- Do not dispatch implementation subagents in parallel against the same worktree.

## File Structure

Create:

- `src-tauri/Cargo.toml`: Rust package and dependency manifest.
- `src-tauri/build.rs`: Tauri build hook.
- `src-tauri/tauri.conf.json`: Tauri app, bundle, window, permission config.
- `src-tauri/capabilities/default.json`: Tauri command/plugin permissions.
- `src-tauri/src/main.rs`: Tauri builder, plugin registration, app setup.
- `src-tauri/src/lib.rs`: Rust module exports for testability.
- `src-tauri/src/models.rs`: shared serializable data models.
- `src-tauri/src/errors.rs`: command-safe error type.
- `src-tauri/src/events.rs`: event names and emit helpers.
- `src-tauri/src/detector.rs`: content type and preview logic.
- `src-tauri/src/privacy/mod.rs`: sensitive content and blacklist modules.
- `src-tauri/src/privacy/filter.rs`: sensitive content detection.
- `src-tauri/src/privacy/foreground.rs`: Windows foreground app detection.
- `src-tauri/src/database/mod.rs`: database module root.
- `src-tauri/src/database/schema.rs`: SQLite schema SQL.
- `src-tauri/src/database/repository.rs`: database CRUD and search.
- `src-tauri/src/database/migrations.rs`: schema migration and FTS rebuild.
- `src-tauri/src/database/legacy.rs`: Electron database migration.
- `src-tauri/src/settings.rs`: settings side effects.
- `src-tauri/src/clipboard/mod.rs`: clipboard monitoring service.
- `src-tauri/src/clipboard/image.rs`: image metadata/compression helpers.
- `src-tauri/src/paste.rs`: write clipboard and simulate paste.
- `src-tauri/src/hotkeys.rs`: global shortcuts, quick-paste cursor, wheel hook facade.
- `src-tauri/src/tray.rs`: system tray creation and refresh.
- `src-tauri/src/windows.rs`: main window and HUD window helpers.
- `src-tauri/src/cleanup.rs`: retention/max-items cleanup.
- `src-tauri/src/logger.rs`: file logging setup.
- `src/renderer/src/lib/tauriApi.ts`: typed command/event wrapper.
- `src/renderer/src/lib/tauriApi.test.ts`: API wrapper tests.
- `src/renderer/src/components/ClipboardDetail.tsx`: lightweight detail preview.
- `src/renderer/src/components/CommandPanelShell.tsx`: approved A+B+C shell layout.
- `src/renderer/src/components/ErrorBoundary.tsx`: renderer error boundary.
- `src/renderer/src/components/__tests__/ClipboardList.test.tsx`: list behavior tests.
- `src/renderer/src/components/__tests__/SettingsPanel.test.tsx`: settings behavior tests.
- `src/renderer/src/test/setup.ts`: Vitest setup.
- `vite.config.ts`: renderer Vite config replacing electron-vite renderer section.
- `vitest.config.ts`: frontend test config.

Modify:

- `package.json`: replace Electron scripts/dependencies with Tauri/Vite/Vitest scripts and dependencies.
- `pnpm-lock.yaml`: update after dependency install.
- `tsconfig.web.json`: include test setup and Tauri globals.
- `src/shared/types.ts`: keep UI types aligned with Rust command payloads.
- `src/renderer/index.html`: ensure Vite root entry works without electron-vite.
- `src/renderer/hud.html`: keep HUD entry for Tauri window.
- `src/renderer/src/vite-env.d.ts`: replace `window.electron` globals with Tauri-safe declarations.
- `src/renderer/src/hooks/useClipboard.ts`: use `tauriApi`.
- `src/renderer/src/hooks/useSearch.ts`: use `tauriApi`.
- `src/renderer/src/store/clipboardStore.ts`: preserve store and add detail-preview state if needed.
- `src/renderer/src/App.tsx`: use command-panel shell.
- `src/renderer/src/hud.ts`: listen through Tauri events.
- `src/renderer/src/components/ClipboardList.tsx`: use `tauriApi` and improved keyboard behavior.
- `src/renderer/src/components/ClipboardItem.tsx`: updated visual system and actions.
- `src/renderer/src/components/SearchBar.tsx`: command-panel search presentation.
- `src/renderer/src/components/SettingsPanel.tsx`: settings via `tauriApi`.
- `src/renderer/src/components/TitleBar.tsx`: Tauri window controls.
- `src/renderer/src/styles.css`: approved teal/orange visual system.
- `.gitignore`: ignore `.superpowers/` and Tauri build artifacts if missing.

Delete after replacement is passing:

- `src/main/**`
- `electron.vite.config.ts`
- `electron-builder.yml`
- `tsconfig.node.json`
- `dist-electron/` generated output if tracked.

## Task 1: Tauri 2 Project Skeleton And Renderer Build

**Files:**

- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`
- Create: `vite.config.ts`
- Modify: `package.json`
- Modify: `tsconfig.web.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write the expected package script shape**

Create a temporary checklist in the task notes before editing:

```text
Expected package scripts:
dev = vite --host 127.0.0.1
tauri:dev = tauri dev
build:renderer = vite build
build = tauri build
preview = vite preview
typecheck = tsc -p tsconfig.web.json --noEmit
test = vitest run
```

- [ ] **Step 2: Add Tauri/Vite dependencies**

Run:

```powershell
pnpm add @tauri-apps/api
pnpm add -D @tauri-apps/cli vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

Expected: `package.json` and `pnpm-lock.yaml` update. If network is blocked, rerun the failing install command with escalation.

- [ ] **Step 3: Remove Electron-only npm dependencies**

Run:

```powershell
pnpm remove electron electron-builder electron-vite electron-store better-sqlite3 sharp uiohook-napi @types/better-sqlite3
```

Expected: Electron and Node-native runtime dependencies are removed from `package.json`.

- [ ] **Step 4: Create minimal Tauri config**

Create `src-tauri/tauri.conf.json` with app id `com.clipvault.app`, product name `ClipVault`, frontend dist `../dist/renderer`, dev url `http://127.0.0.1:5173`, main window `main`, HUD window `hud`, Windows icon `../resources/icon.ico`, and bundle target `nsis`.

- [ ] **Step 5: Create Rust manifest**

Create `src-tauri/Cargo.toml` with package `clipvault`, edition `2021`, and initial dependencies:

```toml
tauri = { version = "2", features = ["tray-icon", "image-png"] }
tauri-build = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
tokio = { version = "1", features = ["macros", "rt-multi-thread", "time", "sync"] }
tracing = "0.1"
tracing-subscriber = "0.3"
```

- [ ] **Step 6: Create minimal Rust app**

Create `src-tauri/src/lib.rs` with module declarations and a `run()` function. Create `src-tauri/src/main.rs` that calls `clipvault::run()`. The first implementation may expose a single `health_check` command returning `"ok"`.

- [ ] **Step 7: Create renderer Vite config**

Create `vite.config.ts` with root `src/renderer`, build output `../dist/renderer`, inputs `index.html` and `hud.html`, React plugin, and aliases `@` and `@shared`.

- [ ] **Step 8: Update scripts and typecheck**

Modify `package.json` scripts to match Step 1. Keep `react`, `react-dom`, `react-window`, `zustand`, `date-fns`, `lucide-react`, `clsx`, `tailwind-merge`.

Run:

```powershell
pnpm typecheck
```

Expected: likely fails because renderer still references `window.electron`. Record the exact failure; this is acceptable for Task 1 if Rust skeleton and renderer build chain are present.

- [ ] **Step 9: Verify Rust skeleton**

Run:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS.

- [ ] **Step 10: Commit**

Run:

```powershell
git add package.json pnpm-lock.yaml vite.config.ts tsconfig.web.json .gitignore src-tauri
git commit -m "chore: scaffold tauri app"
```

## Task 2: Rust Models, Detector, Privacy Filter

**Files:**

- Create: `src-tauri/src/models.rs`
- Create: `src-tauri/src/errors.rs`
- Create: `src-tauri/src/detector.rs`
- Create: `src-tauri/src/privacy/mod.rs`
- Create: `src-tauri/src/privacy/filter.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: Rust unit tests inside these modules.

- [ ] **Step 1: Write failing detector tests**

Add tests for:

- URL: `https://github.com/xxsby/ClipVault`
- color: `#0D9488`
- email: `xxsby@example.com`
- file path: `D:\phpstudy_pro\WWW\HistoClip\README.md`
- code: `import React from 'react'`
- preview truncation to 200 chars

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml detector
```

Expected: FAIL because `detector` functions are missing.

- [ ] **Step 2: Implement detector**

Implement:

```rust
pub fn detect_content_type(text: &str) -> ClipboardContentType
pub fn create_preview(content: &str, max_len: usize) -> String
pub fn is_file_path_text(content: &str) -> bool
pub fn parse_single_file_path(content: &str) -> Option<PathBuf>
```

Use behavior matching `src/main/clipboard/detector.ts`.

- [ ] **Step 3: Verify detector tests pass**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml detector
```

Expected: PASS.

- [ ] **Step 4: Write failing privacy filter tests**

Add tests for skipping:

- `4111111111111111`
- `123-45-6789`
- `11010519491231002X`
- `password=secret123`
- `AKIAIOSFODNN7EXAMPLE`

Add a non-sensitive test for ordinary code/text.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml privacy
```

Expected: FAIL because filter implementation is missing.

- [ ] **Step 5: Implement privacy filter**

Implement:

```rust
pub fn is_sensitive_content(text: &str) -> bool
```

Use `regex` crate if needed and update `Cargo.toml`.

- [ ] **Step 6: Verify privacy tests pass**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml privacy
```

Expected: PASS.

- [ ] **Step 7: Add serializable models**

Define Rust models matching `src/shared/types.ts`:

```rust
ClipboardContentType
ClipboardMetadata
ClipboardItem
ClipboardInsertInput
AppSettings
HotkeySettings
BlacklistApp
HudPayload
MonitoringStatus
```

Ensure serde rename style emits TypeScript-compatible camelCase fields.

- [ ] **Step 8: Run all Rust tests and format**

Run:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```powershell
git add src-tauri/Cargo.toml src-tauri/src
git commit -m "feat: add tauri core models and detectors"
```

## Task 3: SQLite Repository, Migrations, Legacy Data Compatibility

**Files:**

- Create: `src-tauri/src/database/mod.rs`
- Create: `src-tauri/src/database/schema.rs`
- Create: `src-tauri/src/database/migrations.rs`
- Create: `src-tauri/src/database/repository.rs`
- Create: `src-tauri/src/database/legacy.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: Rust unit/integration tests inside `database` modules.

- [ ] **Step 1: Add database dependencies**

Add to `src-tauri/Cargo.toml`:

```toml
rusqlite = { version = "0.32", features = ["bundled", "backup", "functions"] }
tempfile = "3"
```

- [ ] **Step 2: Write failing migration test**

Test that `init_database(temp_path)` creates:

- `clipboard_items`
- `settings`
- `app_blacklist`
- `clipboard_fts`
- required indexes

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml database::migrations
```

Expected: FAIL because migrations are not implemented.

- [ ] **Step 3: Implement schema and migrations**

Implement SQL equivalent to `src/main/database/schema.ts`, including FTS5 triggers. Include repair/rebuild function for FTS artifacts.

- [ ] **Step 4: Verify migration test passes**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml database::migrations
```

Expected: PASS.

- [ ] **Step 5: Write failing repository CRUD tests**

Test:

- Insert text item.
- Duplicate `content_hash` returns existing item.
- Toggle pin.
- Toggle favorite.
- Delete item.
- Clear non-favorites only.
- Increment use stats.
- Enforce max items deletes oldest non-favorite.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml database::repository
```

Expected: FAIL because repository methods are missing.

- [ ] **Step 6: Implement repository**

Implement methods:

```rust
get_history(limit)
get_item_by_id(id)
insert_clipboard_item(input)
search_items(query, limit)
delete_item(id)
clear_history(include_favorites)
toggle_pin(id)
toggle_favorite(id)
delete_old_items(days)
increment_use_stats(id)
get_settings()
update_setting(key, value)
get_hotkey_settings()
update_hotkey_settings(partial)
list_blacklist_apps()
add_blacklist_app(app_name, app_path)
remove_blacklist_app(id)
get_history_by_offset(offset)
count_items()
```

- [ ] **Step 7: Verify repository tests pass**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml database::repository
```

Expected: PASS.

- [ ] **Step 8: Write failing legacy migration test**

Create a temporary old `clipboard.db` with one pinned item, one favorite item, one setting, and one blacklist row. Assert migration copies/opens data without deleting the old file.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml database::legacy
```

Expected: FAIL because legacy migration is missing.

- [ ] **Step 9: Implement legacy migration**

Implement:

```rust
pub fn migrate_legacy_database(old_path: &Path, new_path: &Path) -> Result<LegacyMigrationResult, AppError>
```

Rules:

- If new DB exists, do nothing.
- If old DB exists and new DB does not, create timestamped `.bak` next to old DB and copy old DB to new path.
- Run migrations on new DB.
- Never delete old DB.

- [ ] **Step 10: Run database tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml database
```

Expected: PASS.

- [ ] **Step 11: Commit**

Run:

```powershell
git add src-tauri/Cargo.toml src-tauri/src/database src-tauri/src/lib.rs
git commit -m "feat: add sqlite repository and migrations"
```

## Task 4: Tauri Commands, Events, Settings, Search

**Files:**

- Create: `src-tauri/src/commands.rs`
- Create: `src-tauri/src/events.rs`
- Create: `src-tauri/src/settings.rs`
- Create: `src-tauri/src/cleanup.rs`
- Create: `src-tauri/src/logger.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Write command unit tests where command logic is pure**

Extract command handlers into testable functions that accept `AppState` dependencies. Add tests for:

- `search_items` trims empty query and returns history.
- `clear_history` rebuilds revision.
- `update_setting` returns full settings.
- `toggle_monitoring` flips state.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands
```

Expected: FAIL before command helpers exist.

- [ ] **Step 2: Implement app state and commands**

Create `AppState` holding:

- database repository
- monitoring state
- history revision
- quick paste cursor state

Expose Tauri commands named exactly:

```text
get_history
get_history_revision
search_items
paste_item
delete_item
toggle_pin
toggle_favorite
get_image_data_url
get_settings
update_setting
list_blacklist
add_blacklist
remove_blacklist
get_hotkeys
check_hotkey_conflicts
check_hotkey_available
update_hotkeys
clear_history
toggle_monitoring
minimize_window
hide_window
test_monitoring
test_hud
```

- [ ] **Step 3: Implement event constants**

Define constants:

```rust
CLIPBOARD_NEW_ITEM = "clipboard:new-item"
CLIPBOARD_FOCUS_SEARCH = "clipboard:focus-search"
CLIPBOARD_OPEN_SETTINGS = "clipboard:open-settings"
CLIPBOARD_OPEN_HOTKEYS = "clipboard:open-hotkeys"
HUD_SHOW = "hud:show"
HISTORY_REVISION = "history:revision"
MONITORING_CHANGED = "monitoring:changed"
```

- [ ] **Step 4: Register commands and plugins**

Register commands in `main.rs`. Register Tauri plugins:

- clipboard manager
- global shortcut
- autostart
- single instance

Add plugin dependencies to `Cargo.toml`.

- [ ] **Step 5: Add capabilities**

Update `src-tauri/capabilities/default.json` to allow only the commands and plugin permissions required by this app. Clipboard read/write permissions must be explicit.

- [ ] **Step 6: Run command tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands settings cleanup
```

Expected: PASS.

- [ ] **Step 7: Run Tauri check**

Run:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```powershell
git add src-tauri
git commit -m "feat: expose tauri commands and app state"
```

## Task 5: Frontend Tauri API Adapter And Tests

**Files:**

- Create: `vitest.config.ts`
- Create: `src/renderer/src/test/setup.ts`
- Create: `src/renderer/src/lib/tauriApi.ts`
- Create: `src/renderer/src/lib/tauriApi.test.ts`
- Modify: `src/renderer/src/vite-env.d.ts`
- Modify: `src/renderer/src/hooks/useClipboard.ts`
- Modify: `src/renderer/src/hooks/useSearch.ts`
- Modify: `src/renderer/src/components/ClipboardList.tsx`
- Modify: `src/renderer/src/components/SettingsPanel.tsx`
- Modify: `src/renderer/src/components/TitleBar.tsx`
- Modify: `src/renderer/src/hud.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing API adapter tests**

Mock `@tauri-apps/api/core` and `@tauri-apps/api/event`. Test:

- `api.getHistory(50)` invokes `get_history` with `{ limit: 50 }`.
- `api.searchItems("abc")` invokes `search_items`.
- `api.onNewItem(handler)` listens to `clipboard:new-item` and unwraps payload.
- unsubscribe returned by listen is called.

Run:

```powershell
pnpm test src/renderer/src/lib/tauriApi.test.ts
```

Expected: FAIL because adapter does not exist.

- [ ] **Step 2: Implement `tauriApi.ts`**

Export a typed `clipboardApi` object matching the old `ClipboardApi` shape from `src/shared/types.ts`, but implemented with Tauri `invoke`/`listen`.

- [ ] **Step 3: Verify adapter tests pass**

Run:

```powershell
pnpm test src/renderer/src/lib/tauriApi.test.ts
```

Expected: PASS.

- [ ] **Step 4: Replace `window.electron` references**

Replace all renderer calls with `clipboardApi`. Keep behavior unchanged.

Search command:

```powershell
rg "window\\.electron|Electron\\." src\\renderer\\src
```

Expected after replacement: no matches.

- [ ] **Step 5: Replace window close behavior**

In `ClipboardList.tsx`, replace `window.close()` Escape handling with `clipboardApi.hideWindow()`.

- [ ] **Step 6: Update type declarations**

Remove `window.electron` global declarations from `vite-env.d.ts`. Keep Vite and test typings.

- [ ] **Step 7: Verify frontend tests and typecheck**

Run:

```powershell
pnpm test
pnpm typecheck
```

Expected: PASS or only fail on UI tests not yet created. Typecheck must pass.

- [ ] **Step 8: Commit**

Run:

```powershell
git add package.json pnpm-lock.yaml vitest.config.ts src/renderer/src
git commit -m "feat: migrate renderer ipc to tauri api"
```

## Task 6: Clipboard Monitoring, Image Processing, Paste, Hotkeys, Tray, Windows

**Files:**

- Create: `src-tauri/src/clipboard/mod.rs`
- Create: `src-tauri/src/clipboard/image.rs`
- Create: `src-tauri/src/paste.rs`
- Create: `src-tauri/src/hotkeys.rs`
- Create: `src-tauri/src/tray.rs`
- Create: `src-tauri/src/windows.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Write quick-paste cursor tests**

Test that:

- first older move selects offset 1 when history has at least 2 items.
- newer move clamps at offset 0.
- head id change resets cursor.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml hotkeys
```

Expected: FAIL because quick cursor is missing.

- [ ] **Step 2: Implement pure hotkey cursor logic**

Implement quick cursor as a pure struct independent from Tauri:

```rust
QuickPasteCursor::resolve(direction, total, head_id)
```

Then connect it to repository lookups.

- [ ] **Step 3: Verify hotkey tests pass**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml hotkeys
```

Expected: PASS.

- [ ] **Step 4: Write cleanup and monitoring state tests**

Test monitoring toggles and diagnostics without accessing OS clipboard.

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml clipboard
```

Expected: FAIL before monitor state exists.

- [ ] **Step 5: Implement clipboard monitoring service**

Implement:

- 800ms polling interval.
- settings cache.
- text size limit.
- sensitive filter.
- blacklist check.
- last hash duplicate suppression.
- event emit on inserted item.

Image reading can be guarded behind the clipboard plugin/system API abstraction so tests use fake providers.

- [ ] **Step 6: Implement image helper**

Use Rust image processing crate to return:

```rust
ProcessedImage { bytes, original_size, compressed_size, width, height }
```

Rules match spec:

- under 500KB: keep original.
- 500KB to 5MB: compress high quality and fit inside 1920x1080.
- over 5MB: compress lower quality and fit inside 1920x1080.

- [ ] **Step 7: Implement paste**

Implement text/image/file paste by writing system clipboard, hiding main window, sleeping around 120ms, then using Windows `SendInput` for Ctrl+V. On non-Windows builds, return a clear unsupported error for paste simulation.

- [ ] **Step 8: Implement global shortcuts**

Register:

- open panel
- focus search
- pause monitoring
- clear history
- quick paste prev/next

Implement conflict detection by trying registration/unregistration where safe.

- [ ] **Step 9: Implement wheel hook facade**

For Windows, add low-level mouse hook behind feature-gated module. Keep API:

```rust
start_wheel_hook(options)
stop_wheel_hook()
```

If hook setup fails, log warning and keep keyboard shortcuts working.

- [ ] **Step 10: Implement tray**

Use Tauri tray to provide:

- Open ClipVault
- Pause/Resume monitoring
- Clear history
- Settings
- Quit

Switch active/paused icon resource.

- [ ] **Step 11: Implement windows and HUD**

Main window:

- frameless
- 600x800
- min 520x640
- hide on close

HUD window:

- transparent
- always on top
- skip taskbar
- non-focus behavior where supported
- listens to `hud:show`.

- [ ] **Step 12: Verify Rust checks**

Run:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS.

- [ ] **Step 13: Commit**

Run:

```powershell
git add src-tauri
git commit -m "feat: add tauri desktop integrations"
```

## Task 7: UI Redesign To Approved Command Panel

**Files:**

- Create: `src/renderer/src/components/CommandPanelShell.tsx`
- Create: `src/renderer/src/components/ClipboardDetail.tsx`
- Create: `src/renderer/src/components/ErrorBoundary.tsx`
- Create: `src/renderer/src/components/__tests__/ClipboardList.test.tsx`
- Create: `src/renderer/src/components/__tests__/SettingsPanel.test.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/components/ClipboardItem.tsx`
- Modify: `src/renderer/src/components/ClipboardList.tsx`
- Modify: `src/renderer/src/components/SearchBar.tsx`
- Modify: `src/renderer/src/components/SettingsPanel.tsx`
- Modify: `src/renderer/src/components/TitleBar.tsx`
- Modify: `src/renderer/src/components/TypeFilter.tsx`
- Modify: `src/renderer/src/styles.css`
- Modify: `tailwind.config.ts`

- [ ] **Step 1: Write failing list behavior tests**

Test:

- filters favorites.
- arrow down selects next item.
- Enter calls paste for selected item.
- Delete calls delete for selected item.

Run:

```powershell
pnpm test src/renderer/src/components/__tests__/ClipboardList.test.tsx
```

Expected: FAIL until tests and API mocks are wired.

- [ ] **Step 2: Implement test setup and stable component seams**

Use `clipboardApi` mock injection where needed. Avoid testing react-window internals; test user-visible behavior through rendered rows.

- [ ] **Step 3: Verify list tests pass**

Run:

```powershell
pnpm test src/renderer/src/components/__tests__/ClipboardList.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Write failing settings tests**

Test:

- toggling sensitive filter calls `updateSetting`.
- hotkey update calls `updateHotkeys`.
- blacklist add/remove calls corresponding API.

Run:

```powershell
pnpm test src/renderer/src/components/__tests__/SettingsPanel.test.tsx
```

Expected: FAIL before settings refactor.

- [ ] **Step 5: Refactor shell layout**

Implement approved UI direction:

- command-panel single column.
- teal/orange visual system.
- top search with shortcut hint.
- compact type filter.
- virtualized list.
- lightweight selected detail preview.
- status footer.

- [ ] **Step 6: Update item visuals**

Use Lucide icons, not emoji. Keep actions:

- paste
- pin
- favorite
- delete
- select

Add clear focus and hover states.

- [ ] **Step 7: Update HUD UI**

Keep compact transparent HUD and align with C-style lightweight feedback.

- [ ] **Step 8: Verify frontend tests**

Run:

```powershell
pnpm test
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```powershell
git add src/renderer/src tailwind.config.ts
git commit -m "feat: redesign clipvault command panel"
```

## Task 8: Remove Electron Runtime And Old Main Process

**Files:**

- Delete: `src/main/**`
- Delete: `electron.vite.config.ts`
- Delete: `electron-builder.yml`
- Delete: `tsconfig.node.json`
- Modify: `tsconfig.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.gitignore`

- [ ] **Step 1: Verify no renderer Electron references**

Run:

```powershell
rg "electron|electron-vite|electron-builder|better-sqlite3|uiohook|sharp|dist-electron|window\\.electron" package.json src tsconfig*.json *.ts *.yml
```

Expected: matches only in deleted files or docs before cleanup.

- [ ] **Step 2: Delete old Electron source/config**

Delete old Electron main/preload source and Electron build config. Do not delete `src/shared/types.ts`.

- [ ] **Step 3: Update TypeScript project config**

Remove `tsconfig.node.json` references from root `tsconfig.json`. Keep renderer/shared strict checks.

- [ ] **Step 4: Verify no Electron dependencies remain**

Run:

```powershell
pnpm install
rg "\"electron\"|electron-builder|electron-vite|better-sqlite3|uiohook-napi|sharp" package.json pnpm-lock.yaml
```

Expected: no matches in `package.json`; lockfile may include transitive packages only if pulled by non-Electron dependencies. Investigate direct matches.

- [ ] **Step 5: Run checks**

Run:

```powershell
pnpm typecheck
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add -A
git commit -m "chore: remove electron runtime"
```

## Task 9: Build, Manual Verification Checklist, Size Report

**Files:**

- Create: `docs/superpowers/verification/2026-06-05-tauri2-migration.md`
- Modify: `README.md`

- [ ] **Step 1: Run full automated verification**

Run:

```powershell
pnpm typecheck
pnpm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
pnpm build
```

Expected: PASS.

- [ ] **Step 2: Build installer**

Run:

```powershell
pnpm tauri build
```

Expected: Windows installer and bundle artifacts are produced under `src-tauri/target/release/bundle`.

- [ ] **Step 3: Record size comparison**

Measure:

```powershell
Get-ChildItem -Recurse -File dist | Measure-Object -Property Length -Sum
Get-ChildItem -Recurse -File src-tauri\\target\\release\\bundle | Sort-Object Length -Descending | Select-Object -First 20 FullName,Length
```

Record current Electron baseline as about 390MB unpacked from prior measurement.

- [ ] **Step 4: Execute manual Windows checklist**

Verify and record:

- text copy appears within 1 second.
- image copy appears and previews.
- file path stores metadata only.
- sensitive content is skipped.
- blacklist app is skipped.
- `Ctrl+Shift+V` opens/hides.
- `Ctrl+Shift+F` focuses search.
- `Ctrl+Shift+P` pauses/resumes and tray updates.
- `Ctrl+Shift+C` clears non-favorites.
- `Ctrl+Alt+Left/Right` quick-pastes and shows HUD.
- wheel shortcut works when enabled.
- tray menu actions work.
- autostart setting persists.
- second instance focuses existing window.

- [ ] **Step 5: Update README**

Document:

- Tauri 2 setup.
- `pnpm tauri:dev`.
- `pnpm build`.
- Windows WebView2 note.
- privacy defaults.

- [ ] **Step 6: Commit**

Run:

```powershell
git add README.md docs/superpowers/verification/2026-06-05-tauri2-migration.md
git commit -m "docs: add tauri migration verification notes"
```

## Plan Self-Review

Spec coverage:

- Tauri 2 skeleton: Task 1.
- Rust models, detector, privacy: Task 2.
- SQLite, FTS, legacy data compatibility: Task 3.
- Commands/events/settings/search: Task 4.
- Frontend Tauri API: Task 5.
- Clipboard, image, paste, hotkeys, tray, windows, HUD: Task 6.
- Approved UI direction: Task 7.
- Electron removal: Task 8.
- Verification, size report, packaging: Task 9.

Known execution risks:

- Dependency installation and first Tauri build may require network access.
- Windows low-level mouse hook and `SendInput` must be verified manually on Windows.
- If Tauri plugin APIs differ from the latest docs, implementation must adapt while preserving command/event contracts from this plan.
