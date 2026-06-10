# Quick Copy And Fixed Content Hotkeys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change history prev/next hotkeys to copy only, and add configurable fixed text hotkeys that paste their own content.

**Architecture:** Keep normal clipboard history and fixed shortcut content separate. Rust owns persistence, validation, global shortcut registration, clipboard writes, paste simulation, and HUD events; React only edits settings through Tauri commands. Fixed content is stored in a new SQLite table and participates in hotkey conflict detection only when enabled.

**Tech Stack:** Tauri 2, Rust 2021, rusqlite, tauri-plugin-global-shortcut, tauri-plugin-clipboard-manager, React 18, TypeScript, Vitest, Testing Library.

---

## File Structure

- Modify `src-tauri/src/models.rs`: add `FixedContent` and `FixedContentInput`; keep camelCase serialization.
- Modify `src-tauri/src/database/schema.rs`: create `fixed_contents` table and enabled-hotkey unique index.
- Modify `src-tauri/src/database/migrations.rs`: update schema creation tests to expect `fixed_contents`.
- Modify `src-tauri/src/database/repository.rs`: add fixed content CRUD, lookup, and usage-stat methods.
- Modify `src-tauri/src/commands.rs`: add fixed content commands, validation, hotkey conflict handling, and registration refresh side effects.
- Modify `src-tauri/src/hotkeys.rs`: change history quick action to copy only; register and handle fixed content hotkeys.
- Modify `src-tauri/src/lib.rs`: expose new commands.
- Modify `src-tauri/permissions/clipvault.toml`: allow new commands.
- Modify `src/shared/types.ts`: add fixed content types and API methods.
- Modify `src/renderer/src/lib/tauriApi.ts` and `src/renderer/src/lib/tauriApi.test.ts`: map and test fixed content commands.
- Modify `src/renderer/src/components/SettingsPanel.tsx` and `src/renderer/src/components/__tests__/SettingsPanel.test.tsx`: add fixed content UI and update quick history copy wording.
- Do not modify wheel shortcut defaults or hook behavior.

---

### Task 1: History Prev/Next Copies Instead Of Pasting

**Files:**
- Modify: `src-tauri/src/hotkeys.rs`

- [ ] **Step 1: Write the failing Rust test**

Add tests in `src-tauri/src/hotkeys.rs` under the existing `#[cfg(test)] mod tests` block. Use a temporary repository and call a new helper that does not exist yet:

```rust
use tempfile::tempdir;

use crate::{
    commands::AppState,
    database::repository::Repository,
    models::{ClipboardContentType, ClipboardInsertInput},
};

fn repo() -> Repository {
    let dir = tempdir().unwrap();
    Repository::open(dir.path().join("clipboard.db")).unwrap()
}

fn text_input(content: &str, hash: &str) -> ClipboardInsertInput {
    ClipboardInsertInput {
        content: Some(content.to_string()),
        content_type: ClipboardContentType::Text,
        content_hash: hash.to_string(),
        preview: content.to_string(),
        metadata: None,
        file_path: None,
        image_data: None,
    }
}

#[test]
fn quick_history_action_uses_copy_result_and_updates_cursor() {
    let state = AppState::new(repo());
    state
        .repository()
        .insert_clipboard_item(text_input("newest", "hash-newest"))
        .unwrap();
    let older = state
        .repository()
        .insert_clipboard_item(text_input("older", "hash-older"))
        .unwrap();

    let mut copied = Vec::new();
    let result = copy_quick_history_item(&state, QuickPasteDirection::Older, |item| {
        copied.push(item.content.clone().unwrap());
        Ok(())
    })
    .unwrap()
    .unwrap();

    assert_eq!(copied, vec!["older".to_string()]);
    assert!(result.success);
    assert_eq!(result.message, "copied");
    assert_eq!(result.item.as_ref().unwrap().id, older.id);
    assert_eq!(state.quick_paste_cursor().offset, Some(1));
}

#[test]
fn quick_history_action_does_not_update_use_stats_when_copy_fails() {
    let state = AppState::new(repo());
    state
        .repository()
        .insert_clipboard_item(text_input("newest", "hash-newest"))
        .unwrap();
    let older = state
        .repository()
        .insert_clipboard_item(text_input("older", "hash-older"))
        .unwrap();

    let result = copy_quick_history_item(&state, QuickPasteDirection::Older, |_| {
        Err(crate::errors::AppError::from("copy failed"))
    })
    .unwrap()
    .unwrap();

    let stored = state.repository().get_item_by_id(older.id).unwrap().unwrap();
    assert!(!result.success);
    assert_eq!(result.message, "copy failed");
    assert_eq!(stored.use_count, 0);
    assert_eq!(stored.last_used_at, None);
}
```

- [ ] **Step 2: Run the focused failing test**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml quick_history_action -- --nocapture
```

Expected: compile failure because `copy_quick_history_item` is not defined.

- [ ] **Step 3: Implement the helper and route hotkeys through it**

In `src-tauri/src/hotkeys.rs`, add a private helper near `quick_paste`:

```rust
fn copy_quick_history_item<F>(
    state: &AppState,
    direction: QuickPasteDirection,
    copy: F,
) -> AppResult<Option<commands::PasteResult>>
where
    F: FnOnce(&ClipboardItem) -> AppResult<()>,
{
    let total = state.repository().count_items()?;
    let history = state.repository().get_history(1)?;
    let head_id = history.first().map(|item| item.id);
    let Some(offset) =
        state.quick_paste_cursor_mut(|cursor| cursor.resolve(direction, total, head_id))
    else {
        return Ok(None);
    };

    let Some(item) = state.repository().get_history_by_offset(offset)? else {
        return Ok(None);
    };

    commands::copy_item_impl(state, item.id, copy).map(Some)
}
```

Then update `quick_paste` so it calls:

```rust
let result = copy_quick_history_item(state.inner(), direction, |item| {
    paste::write_item_to_clipboard(app, item)
})?;
```

Keep existing HUD emission, but emit it using the copied item from `result.item` after a successful item lookup. Do not call `paste::write_clipboard_and_paste` in this path.

- [ ] **Step 4: Run the focused test until it passes**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml quick_history_action -- --nocapture
```

Expected: both `quick_history_action_*` tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/hotkeys.rs
git commit -m "fix: copy history items from quick hotkeys"
```

---

### Task 2: Fixed Content Persistence

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/database/schema.rs`
- Modify: `src-tauri/src/database/migrations.rs`
- Modify: `src-tauri/src/database/repository.rs`

- [ ] **Step 1: Write failing repository and schema tests**

Add this to `src-tauri/src/database/repository.rs` tests:

```rust
use crate::models::FixedContentInput;

fn fixed_input(title: &str, content: &str, hotkey: &str, enabled: bool) -> FixedContentInput {
    FixedContentInput {
        title: title.to_string(),
        content: content.to_string(),
        hotkey: hotkey.to_string(),
        enabled,
    }
}

#[test]
fn fixed_contents_round_trip_and_track_usage() {
    let repo = repo();

    let created = repo
        .create_fixed_content(&fixed_input("Topic A", "A", "Ctrl+1", true))
        .unwrap();
    assert_eq!(created.title, "Topic A");
    assert_eq!(created.content, "A");
    assert_eq!(created.hotkey, "Ctrl+1");
    assert!(created.enabled);
    assert_eq!(created.use_count, 0);

    let listed = repo.list_fixed_contents().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, created.id);

    let updated = repo
        .update_fixed_content(created.id, &fixed_input("Topic B", "B", "Ctrl+2", false))
        .unwrap()
        .unwrap();
    assert_eq!(updated.title, "Topic B");
    assert_eq!(updated.content, "B");
    assert_eq!(updated.hotkey, "Ctrl+2");
    assert!(!updated.enabled);

    let used = repo.increment_fixed_content_use_stats(created.id).unwrap().unwrap();
    assert_eq!(used.use_count, 1);
    assert!(used.last_used_at.is_some());

    assert!(repo.delete_fixed_content(created.id).unwrap());
    assert!(repo.list_fixed_contents().unwrap().is_empty());
}

#[test]
fn fixed_content_enabled_hotkeys_are_unique() {
    let repo = repo();
    repo.create_fixed_content(&fixed_input("A", "A", "Ctrl+1", true))
        .unwrap();

    let duplicate = repo
        .create_fixed_content(&fixed_input("B", "B", "Ctrl+1", true))
        .unwrap_err();
    assert!(duplicate.to_string().contains("fixed_contents"));

    let disabled_duplicate = repo
        .create_fixed_content(&fixed_input("C", "C", "Ctrl+1", false))
        .unwrap();
    assert!(!disabled_duplicate.enabled);
}
```

In `src-tauri/src/database/migrations.rs`, extend `init_database_creates_legacy_compatible_schema` to expect `"fixed_contents"` in the table list and `"idx_fixed_contents_hotkey_enabled"` in the index list.

- [ ] **Step 2: Run failing tests**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml fixed_content -- --nocapture
cargo test --manifest-path src-tauri\Cargo.toml init_database_creates_legacy_compatible_schema -- --nocapture
```

Expected: compile failures for missing `FixedContentInput` and repository methods.

- [ ] **Step 3: Add fixed content models**

In `src-tauri/src/models.rs`, add:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedContent {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub hotkey: String,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
    pub use_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedContentInput {
    pub title: String,
    pub content: String,
    pub hotkey: String,
    pub enabled: bool,
}
```

- [ ] **Step 4: Add schema**

In `src-tauri/src/database/schema.rs`, add `FIXED_CONTENTS_TABLE` and append the `CREATE TABLE IF NOT EXISTS fixed_contents` SQL plus the partial unique index from the spec.

- [ ] **Step 5: Add repository methods**

In `src-tauri/src/database/repository.rs`, import `FixedContent` and `FixedContentInput`. Add:

```rust
pub fn list_fixed_contents(&self) -> AppResult<Vec<FixedContent>>
pub fn get_fixed_content_by_id(&self, id: i64) -> AppResult<Option<FixedContent>>
pub fn create_fixed_content(&self, input: &FixedContentInput) -> AppResult<FixedContent>
pub fn update_fixed_content(&self, id: i64, input: &FixedContentInput) -> AppResult<Option<FixedContent>>
pub fn delete_fixed_content(&self, id: i64) -> AppResult<bool>
pub fn increment_fixed_content_use_stats(&self, id: i64) -> AppResult<Option<FixedContent>>
```

Use `now_timestamp()` for `created_at`, `updated_at`, and usage updates. Add a `map_fixed_content` row mapper with boolean conversion `enabled != 0`.

- [ ] **Step 6: Run tests until green**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml fixed_content -- --nocapture
cargo test --manifest-path src-tauri\Cargo.toml init_database_creates_legacy_compatible_schema -- --nocapture
```

Expected: fixed content repository and schema tests pass.

- [ ] **Step 7: Commit**

```powershell
git add src-tauri/src/models.rs src-tauri/src/database/schema.rs src-tauri/src/database/migrations.rs src-tauri/src/database/repository.rs
git commit -m "feat: persist fixed shortcut content"
```

---

### Task 3: Fixed Content Commands And Hotkey Registration

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/hotkeys.rs`
- Modify: `src-tauri/src/paste.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/permissions/clipvault.toml`

- [ ] **Step 1: Write failing command tests**

In `src-tauri/src/commands.rs` tests, add:

```rust
use crate::models::FixedContentInput;

fn fixed_input(title: &str, content: &str, hotkey: &str, enabled: bool) -> FixedContentInput {
    FixedContentInput {
        title: title.to_string(),
        content: content.to_string(),
        hotkey: hotkey.to_string(),
        enabled,
    }
}

#[test]
fn fixed_content_candidate_rejects_blank_and_invalid_values() {
    let blank_title = super::validate_fixed_content_input(&fixed_input(" ", "A", "Ctrl+1", true))
        .unwrap_err();
    assert!(blank_title.to_string().contains("title"));

    let blank_content =
        super::validate_fixed_content_input(&fixed_input("A", " ", "Ctrl+1", true)).unwrap_err();
    assert!(blank_content.to_string().contains("content"));

    let invalid_hotkey = super::validate_fixed_content_input(&fixed_input(
        "A",
        "A",
        "not-a-hotkey",
        true,
    ))
    .unwrap_err();
    assert!(invalid_hotkey.to_string().contains("hotkey"));
}

#[test]
fn fixed_content_conflicts_with_existing_enabled_hotkeys() {
    let state = super::AppState::new(repo());
    state
        .repository()
        .create_fixed_content(&fixed_input("A", "A", "Ctrl+1", true))
        .unwrap();

    let duplicate = super::validate_fixed_content_hotkey_conflicts(
        &state,
        None,
        &fixed_input("B", "B", "Ctrl+1", true),
    )
    .unwrap_err();
    assert!(duplicate.to_string().contains("Ctrl+1"));

    let disabled_duplicate = super::validate_fixed_content_hotkey_conflicts(
        &state,
        None,
        &fixed_input("B", "B", "Ctrl+1", false),
    );
    assert!(disabled_duplicate.is_ok());
}

#[test]
fn fixed_content_trigger_updates_usage_after_successful_paste() {
    let state = super::AppState::new(repo());
    let fixed = super::create_fixed_content_impl(
        &state,
        fixed_input("A", "Pinned A", "Ctrl+1", true),
    )
    .unwrap();

    let mut pasted = Vec::new();
    let result = super::trigger_fixed_content_impl(&state, fixed.id, |item| {
        pasted.push(item.content.clone());
        Ok(())
    })
    .unwrap();

    assert!(result.is_some());
    let used = result.unwrap();
    assert_eq!(pasted, vec!["Pinned A".to_string()]);
    assert_eq!(used.use_count, 1);
    assert!(used.last_used_at.is_some());
}

#[test]
fn fixed_content_trigger_skips_disabled_content() {
    let state = super::AppState::new(repo());
    let fixed = super::create_fixed_content_impl(
        &state,
        fixed_input("A", "Pinned A", "Ctrl+1", false),
    )
    .unwrap();

    let result = super::trigger_fixed_content_impl(&state, fixed.id, |_| {
        panic!("disabled fixed content should not paste")
    })
    .unwrap();

    assert!(result.is_none());
}
```

- [ ] **Step 2: Run failing command tests**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml fixed_content_ -- --nocapture
```

Expected: compile failures for missing validation and trigger functions.

- [ ] **Step 3: Add command helpers**

In `src-tauri/src/commands.rs`, add imports for `FixedContent` and `FixedContentInput`, then add:

```rust
pub fn validate_fixed_content_input(input: &FixedContentInput) -> AppResult<FixedContentInput>
pub fn validate_fixed_content_hotkey_conflicts(
    state: &AppState,
    current_id: Option<i64>,
    input: &FixedContentInput,
) -> AppResult<()>
pub fn list_fixed_contents_impl(state: &AppState) -> AppResult<Vec<FixedContent>>
pub fn create_fixed_content_impl(state: &AppState, input: FixedContentInput) -> AppResult<FixedContent>
pub fn update_fixed_content_impl(state: &AppState, id: i64, input: FixedContentInput) -> AppResult<FixedContent>
pub fn delete_fixed_content_impl(state: &AppState, id: i64) -> AppResult<bool>
pub fn trigger_fixed_content_impl<F>(
    state: &AppState,
    id: i64,
    paste: F,
) -> AppResult<Option<FixedContent>>
where
    F: FnOnce(&FixedContent) -> AppResult<()>
```

Validation must trim `title`, `content`, and `hotkey`, reject empty values, parse hotkey with `tauri_plugin_global_shortcut::Shortcut`, check against `HotkeySettings`, and check enabled fixed content duplicates excluding `current_id`.

- [ ] **Step 4: Add Tauri commands and registration side effects**

Expose commands:

```rust
#[tauri::command]
pub fn list_fixed_contents(state: State<'_, AppState>) -> AppResult<Vec<FixedContent>>

#[tauri::command]
pub fn create_fixed_content(
    app: AppHandle,
    state: State<'_, AppState>,
    input: FixedContentInput,
) -> AppResult<FixedContent>

#[tauri::command]
pub fn update_fixed_content(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    input: FixedContentInput,
) -> AppResult<FixedContent>

#[tauri::command]
pub fn delete_fixed_content(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> AppResult<bool>
```

After create/update/delete, call a new hotkey refresh function that registers ordinary hotkeys plus enabled fixed content hotkeys. If refresh fails after persistence, restore registration from the repository's current state and return the error.

- [ ] **Step 5: Extend hotkey registration**

In `src-tauri/src/hotkeys.rs`:

- Add `HotkeyAction::FixedContent(i64)`.
- Add `replace_all_keyboard_shortcuts(app: &AppHandle, state: &AppState)`.
- Keep `replace_keyboard_shortcuts(app, settings)` for tests and current callers, but have full app flows use `replace_all_keyboard_shortcuts`.
- Register each enabled fixed content with `HotkeyAction::FixedContent(id)`.
- In `handle_hotkey_action`, call `commands::trigger_fixed_content_impl(state.inner(), id, |item| paste::write_fixed_text_and_paste(app, &item.content))`.

If adding `write_fixed_text_and_paste` is cleaner, implement it in `src-tauri/src/paste.rs` as a text-only wrapper that writes text, hides the main window, and simulates `Ctrl+V`.

- [ ] **Step 6: Update invoke handler and permissions**

Add the four new commands to `src-tauri/src/lib.rs` and `src-tauri/permissions/clipvault.toml`.

- [ ] **Step 7: Run focused Rust tests**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml fixed_content_ -- --nocapture
cargo test --manifest-path src-tauri\Cargo.toml validates_hotkey_settings_before_registration -- --nocapture
```

Expected: fixed content command tests and existing hotkey validation tests pass.

- [ ] **Step 8: Commit**

```powershell
git add src-tauri/src/commands.rs src-tauri/src/hotkeys.rs src-tauri/src/paste.rs src-tauri/src/lib.rs src-tauri/permissions/clipvault.toml
git commit -m "feat: register fixed content hotkeys"
```

---

### Task 4: Shared Types And Tauri API

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/src/lib/tauriApi.ts`
- Modify: `src/renderer/src/lib/tauriApi.test.ts`

- [ ] **Step 1: Write failing adapter tests**

In `src/renderer/src/lib/tauriApi.test.ts`, add:

```ts
it('maps fixed content commands', async () => {
  const { clipboardApi } = await import('./tauriApi');
  const fixed = {
    id: 1,
    title: 'Topic A',
    content: 'Pinned A',
    hotkey: 'Ctrl+1',
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    lastUsedAt: null,
    useCount: 0
  };

  invokeMock.mockResolvedValueOnce([fixed]);
  await expect(clipboardApi.listFixedContents()).resolves.toEqual([fixed]);
  expect(invokeMock).toHaveBeenLastCalledWith('list_fixed_contents');

  invokeMock.mockResolvedValueOnce(fixed);
  await expect(
    clipboardApi.createFixedContent({
      title: 'Topic A',
      content: 'Pinned A',
      hotkey: 'Ctrl+1',
      enabled: true
    })
  ).resolves.toEqual(fixed);
  expect(invokeMock).toHaveBeenLastCalledWith('create_fixed_content', {
    input: {
      title: 'Topic A',
      content: 'Pinned A',
      hotkey: 'Ctrl+1',
      enabled: true
    }
  });

  invokeMock.mockResolvedValueOnce(fixed);
  await expect(
    clipboardApi.updateFixedContent(1, {
      title: 'Topic A',
      content: 'Pinned A',
      hotkey: 'Ctrl+1',
      enabled: false
    })
  ).resolves.toEqual(fixed);
  expect(invokeMock).toHaveBeenLastCalledWith('update_fixed_content', {
    id: 1,
    input: {
      title: 'Topic A',
      content: 'Pinned A',
      hotkey: 'Ctrl+1',
      enabled: false
    }
  });

  invokeMock.mockResolvedValueOnce(true);
  await expect(clipboardApi.deleteFixedContent(1)).resolves.toBeUndefined();
  expect(invokeMock).toHaveBeenLastCalledWith('delete_fixed_content', { id: 1 });
});
```

- [ ] **Step 2: Run failing adapter test**

Run:

```powershell
pnpm test src/renderer/src/lib/tauriApi.test.ts
```

Expected: TypeScript compile failure because fixed content API methods do not exist.

- [ ] **Step 3: Add shared types**

In `src/shared/types.ts`, add:

```ts
export interface FixedContent {
  id: number;
  title: string;
  content: string;
  hotkey: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  useCount: number;
}

export interface FixedContentInput {
  title: string;
  content: string;
  hotkey: string;
  enabled: boolean;
}
```

Extend `ClipboardApi` with:

```ts
listFixedContents: () => Promise<FixedContent[]>;
createFixedContent: (input: FixedContentInput) => Promise<FixedContent>;
updateFixedContent: (id: number, input: FixedContentInput) => Promise<FixedContent>;
deleteFixedContent: (id: number) => Promise<void>;
```

- [ ] **Step 4: Implement adapter methods**

In `src/renderer/src/lib/tauriApi.ts`, add invoke wrappers for `list_fixed_contents`, `create_fixed_content`, `update_fixed_content`, and `delete_fixed_content`.

- [ ] **Step 5: Run adapter test until green**

Run:

```powershell
pnpm test src/renderer/src/lib/tauriApi.test.ts
```

Expected: adapter tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/shared/types.ts src/renderer/src/lib/tauriApi.ts src/renderer/src/lib/tauriApi.test.ts
git commit -m "feat: expose fixed content api"
```

---

### Task 5: Settings Panel UI

**Files:**
- Modify: `src/renderer/src/components/SettingsPanel.tsx`
- Modify: `src/renderer/src/components/__tests__/SettingsPanel.test.tsx`

- [ ] **Step 1: Write failing UI tests**

In `src/renderer/src/components/__tests__/SettingsPanel.test.tsx`, extend the `clipboardApi` mock with `listFixedContents`, `createFixedContent`, `updateFixedContent`, and `deleteFixedContent`. Add:

```ts
const listFixedContentsMock = vi.fn();
const createFixedContentMock = vi.fn();
const updateFixedContentMock = vi.fn();
const deleteFixedContentMock = vi.fn();

const fixedContent = {
  id: 1,
  title: 'Topic A',
  content: 'Pinned A',
  hotkey: 'Ctrl+1',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  useCount: 0
};
```

Reset defaults in `beforeEach`:

```ts
listFixedContentsMock.mockResolvedValue([fixedContent]);
createFixedContentMock.mockResolvedValue(fixedContent);
updateFixedContentMock.mockResolvedValue(fixedContent);
deleteFixedContentMock.mockResolvedValue(undefined);
```

Add tests:

```ts
it('shows history hotkeys as copy actions', async () => {
  renderPanel('hotkeys');

  expect(await screen.findByText('历史快速复制')).toBeInTheDocument();
  expect(screen.getByText(/复制更旧的历史内容到剪贴板/)).toBeInTheDocument();
});

it('renders fixed content hotkeys and creates a new one', async () => {
  renderPanel('hotkeys');

  expect(await screen.findByText('固定快捷内容')).toBeInTheDocument();
  expect(await screen.findByText('Topic A')).toBeInTheDocument();
  expect(screen.getByText('Ctrl+1')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /新增固定内容/ }));
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Topic B' } });
  fireEvent.change(screen.getByLabelText('内容'), { target: { value: 'Pinned B' } });
  fireEvent.click(screen.getByRole('button', { name: /录制固定内容快捷键/ }));
  fireEvent.keyDown(window, { key: 'Control' });
  fireEvent.keyDown(window, { key: '2' });
  fireEvent.keyUp(window, { key: '2' });
  fireEvent.click(screen.getByRole('button', { name: /保存固定内容/ }));

  await waitFor(() => {
    expect(createFixedContentMock).toHaveBeenCalledWith({
      title: 'Topic B',
      content: 'Pinned B',
      hotkey: 'Ctrl+2',
      enabled: true
    });
  });
});
```

- [ ] **Step 2: Run failing UI tests**

Run:

```powershell
pnpm test src/renderer/src/components/__tests__/SettingsPanel.test.tsx
```

Expected: failures because fixed content UI does not exist and wording still says quick paste.

- [ ] **Step 3: Implement UI state and loading**

In `SettingsPanel.tsx`:

- Import `FixedContent` and `FixedContentInput`.
- Add state for `fixedContents`, `fixedFormOpen`, `editingFixedContent`, and form fields.
- When hotkeys tab opens, call `clipboardApi.listFixedContents()`.
- After create/update/delete, refresh the list.

- [ ] **Step 4: Update wording**

Change labels/descriptions:

- `quickPastePrev`: label `复制上一项历史`
- `quickPasteNext`: label `复制下一项历史`
- group title `历史快速复制`
- descriptions mention copying to clipboard, not direct paste.

- [ ] **Step 5: Add fixed content section**

Add a fixed content panel below history hotkeys:

- Existing rows show title, `formatHotkeyLabel(item.hotkey)`, enabled state, content preview, edit/delete buttons.
- Add button text `新增固定内容`.
- Form fields have accessible labels `标题` and `内容`.
- Shortcut recording button has accessible name `录制固定内容快捷键`.
- Save button text is `保存固定内容`.
- Use existing visual style and avoid nested cards inside cards.

- [ ] **Step 6: Run UI tests until green**

Run:

```powershell
pnpm test src/renderer/src/components/__tests__/SettingsPanel.test.tsx
```

Expected: SettingsPanel tests pass.

- [ ] **Step 7: Commit**

```powershell
git add src/renderer/src/components/SettingsPanel.tsx src/renderer/src/components/__tests__/SettingsPanel.test.tsx
git commit -m "feat: manage fixed content hotkeys"
```

---

### Task 6: Full Verification

**Files:**
- No planned source edits unless verification exposes failures.

- [ ] **Step 1: Run TypeScript checks**

Run:

```powershell
pnpm typecheck
```

Expected: exit code 0.

- [ ] **Step 2: Run frontend tests**

Run:

```powershell
pnpm test
```

Expected: exit code 0.

- [ ] **Step 3: Run Rust formatting check**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo fmt --manifest-path src-tauri\Cargo.toml --check
```

Expected: exit code 0. If it fails, run `cargo fmt --manifest-path src-tauri\Cargo.toml`, then rerun the check.

- [ ] **Step 4: Run Rust tests**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml
```

Expected: exit code 0.

- [ ] **Step 5: Run Rust clippy**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo clippy --manifest-path src-tauri\Cargo.toml -- -D warnings
```

Expected: exit code 0.

- [ ] **Step 6: Run production build**

Run:

```powershell
pnpm build
```

Expected: exit code 0.

- [ ] **Step 7: Final commit if verification required fixes**

If verification required fixes, commit them:

```powershell
git add <changed-files>
git commit -m "fix: stabilize fixed content hotkeys"
```

---

## Manual Verification Required

These require a real Windows desktop session:

- `Ctrl+Alt+Left/Right` copies selected history content to the clipboard and does not auto-paste.
- A fixed content hotkey such as `Ctrl+1` writes its fixed content and auto-pastes it.
- Fixed content paste does not combine with the previous clipboard content.
- Editing a fixed content hotkey takes effect immediately.
- Deleting or disabling a fixed content makes its hotkey stop working.
- `Ctrl+鼠标滚轮` behavior remains unchanged from before this feature.
