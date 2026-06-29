# Recent Active History Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make used history items return to the top of the main history list while keeping quick previous/next and recent slot hotkeys stable during continuous shortcut use.

**Architecture:** Repository queries will separate main-list ordering from recent-active shortcut ordering. `QuickPasteCursor` will become the short-lived in-memory snapshot used by both previous/next navigation and recent slot resolution. The renderer store will mirror backend ordering so optimistic updates do not reorder items differently from persisted queries.

**Tech Stack:** Rust 2021, Tauri 2, rusqlite, React 18, TypeScript, Zustand, Vitest.

---

## File Structure

- Modify `src-tauri/src/database/repository.rs`
  - Add shared SQL order constants.
  - Change history and search queries to sort by pinned + recent active time.
  - Change recent history lookup to sort by recent active time while ignoring pinned priority.
  - Add repository tests for active ordering and recent slot ordering.
- Modify `src-tauri/src/hotkeys.rs`
  - Shorten quick snapshot timeout from 5 minutes to 1500ms.
  - Reuse the cursor snapshot for recent history slots.
  - Stop merging new IDs into an active snapshot.
  - Add cursor and hotkey behavior tests.
- Modify `src-tauri/src/commands.rs`
  - Anchor clicked history items against the recent-active order that shortcut navigation uses.
- Modify `src/renderer/src/store/clipboardStore.ts`
  - Sort by pinned + recent active time.
- Create `src/renderer/src/store/__tests__/clipboardStore.test.ts`
  - Cover `setItems` and `upsertItem` recent-active ordering.

---

### Task 1: Repository Recent-Active Ordering

**Files:**
- Modify: `src-tauri/src/database/repository.rs`

- [ ] **Step 1: Write failing repository ordering tests**

Add these tests inside the existing `#[cfg(test)] mod tests` in `src-tauri/src/database/repository.rs`, near the existing history ordering tests:

```rust
#[test]
fn get_history_sorts_pinned_first_then_recent_activity() {
    let repo = repo();
    let old = repo
        .insert_clipboard_item(text_input("old", "hash-active-old"))
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    let new = repo
        .insert_clipboard_item(text_input("new", "hash-active-new"))
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    let pinned_old = repo
        .insert_clipboard_item(text_input("pinned old", "hash-active-pinned-old"))
        .unwrap();
    repo.toggle_pin(pinned_old.id).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    let used_old = repo.increment_use_stats(old.id).unwrap();

    let history = repo.get_history(10).unwrap();

    assert_eq!(history[0].id, pinned_old.id);
    assert_eq!(history[1].id, used_old.id);
    assert_eq!(history[2].id, new.id);
}

#[test]
fn recent_history_lookup_uses_recent_activity_and_ignores_pinned_priority() {
    let repo = repo();
    let old = repo
        .insert_clipboard_item(text_input("old", "hash-recent-active-old"))
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    let pinned_new = repo
        .insert_clipboard_item(text_input("new", "hash-recent-active-new"))
        .unwrap();
    repo.toggle_pin(pinned_new.id).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    repo.increment_use_stats(old.id).unwrap();

    let first = repo.get_recent_history_by_offset(0).unwrap().unwrap();
    let second = repo.get_recent_history_by_offset(1).unwrap().unwrap();

    assert_eq!(first.id, old.id);
    assert_eq!(second.id, pinned_new.id);
}

#[test]
fn search_items_sorts_results_by_recent_activity_inside_pinned_groups() {
    let repo = repo();
    let old = repo
        .insert_clipboard_item(text_input("needle old", "hash-search-active-old"))
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    let new = repo
        .insert_clipboard_item(text_input("needle new", "hash-search-active-new"))
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    repo.increment_use_stats(old.id).unwrap();

    let results = repo.search_items("needle", 10).unwrap();

    assert_eq!(results[0].id, old.id);
    assert_eq!(results[1].id, new.id);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml database::repository::tests:: -- --nocapture
```

Expected: at least one test fails because current queries order by `created_at` only.

- [ ] **Step 3: Implement repository ordering**

Add constants near the existing column constants:

```rust
const HISTORY_ORDER: &str =
    "is_pinned DESC, COALESCE(last_used_at, created_at) DESC, created_at DESC, id DESC";
const HISTORY_ORDER_QUALIFIED: &str = "clipboard_items.is_pinned DESC, COALESCE(clipboard_items.last_used_at, clipboard_items.created_at) DESC, clipboard_items.created_at DESC, clipboard_items.id DESC";
const RECENT_HISTORY_ORDER: &str =
    "COALESCE(last_used_at, created_at) DESC, created_at DESC, id DESC";
```

Update `get_history`, `get_history_page`, `get_history_by_offset`, `get_recent_history_by_offset`, and `search_items` so their `ORDER BY` clauses use those constants:

```rust
let sql = format!(
    "SELECT {CLIPBOARD_ITEM_SUMMARY_COLUMNS} FROM clipboard_items
     ORDER BY {HISTORY_ORDER}
     LIMIT ?1"
);
```

```rust
"SELECT * FROM clipboard_items
 ORDER BY {HISTORY_ORDER}
 LIMIT 1 OFFSET ?1"
```

```rust
"SELECT * FROM clipboard_items
 ORDER BY {RECENT_HISTORY_ORDER}
 LIMIT 1 OFFSET ?1"
```

For FTS search, use `HISTORY_ORDER_QUALIFIED`.

- [ ] **Step 4: Run repository tests to verify they pass**

Run the same `cargo test` command from Step 2.

Expected: the three ordering tests pass.

- [ ] **Step 5: Commit repository ordering**

```powershell
git add src-tauri\src\database\repository.rs
git commit -m "fix: order history by recent activity"
```

---

### Task 2: Shortcut Snapshot Semantics

**Files:**
- Modify: `src-tauri/src/hotkeys.rs`
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Write failing cursor and hotkey tests**

In `src-tauri/src/hotkeys.rs`, update or add these tests inside the existing test module:

```rust
#[test]
fn active_session_ignores_new_items_until_idle_timeout() {
    let mut cursor = QuickPasteCursor::default();
    let now = Instant::now();

    assert_eq!(
        cursor.resolve_at(QuickPasteDirection::Older, &[10, 9, 8], now),
        QuickPasteCursorResolution::Item(9)
    );
    assert_eq!(
        cursor.resolve_at(
            QuickPasteDirection::Newer,
            &[11, 10, 9, 8],
            now + Duration::from_millis(500)
        ),
        QuickPasteCursorResolution::Item(10)
    );
    assert_eq!(
        cursor.resolve_at(
            QuickPasteDirection::Newer,
            &[11, 10, 9, 8],
            now + QUICK_PASTE_CURSOR_IDLE_RESET + Duration::from_millis(1)
        ),
        QuickPasteCursorResolution::Boundary(QuickPasteBoundary::Newest)
    );
}

#[test]
fn recent_history_slot_reuses_snapshot_before_idle_timeout() {
    let mut cursor = QuickPasteCursor::default();
    let now = Instant::now();

    assert_eq!(
        cursor.resolve_slot_at(2, &[10, 9, 8], now),
        QuickPasteCursorResolution::Item(9)
    );
    assert_eq!(
        cursor.resolve_slot_at(2, &[9, 10, 8], now + Duration::from_millis(500)),
        QuickPasteCursorResolution::Item(9)
    );
    assert_eq!(
        cursor.resolve_slot_at(
            2,
            &[9, 10, 8],
            now + QUICK_PASTE_CURSOR_IDLE_RESET + Duration::from_millis(1)
        ),
        QuickPasteCursorResolution::Item(10)
    );
}

#[test]
fn recent_history_slot_action_uses_recent_activity_snapshot() {
    let state = AppState::new(repo());
    let old = state
        .repository()
        .insert_clipboard_item(text_input("old", "hash-slot-active-old"))
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    state
        .repository()
        .insert_clipboard_item(text_input("new", "hash-slot-active-new"))
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    state.repository().increment_use_stats(old.id).unwrap();
    let mut pasted_id = None;

    let result = paste_recent_history_slot_item(&state, 1, |item| {
        pasted_id = Some(item.id);
        Ok(())
    })
    .unwrap();

    assert_eq!(pasted_id, Some(old.id));
    assert!(matches!(result, RecentHistorySlotResult::Pasted(_)));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml hotkeys::tests:: -- --nocapture
```

Expected: tests fail because slot resolution does not use a cursor snapshot yet, and active sessions currently merge new IDs.

- [ ] **Step 3: Implement short-lived snapshot behavior**

In `src-tauri/src/hotkeys.rs`, change the timeout:

```rust
const QUICK_PASTE_CURSOR_IDLE_RESET: Duration = Duration::from_millis(1500);
```

Add a helper and slot resolver to `impl QuickPasteCursor`:

```rust
fn prepare_session(&mut self, history_ids: &[i64], now: Instant) -> bool {
    if history_ids.is_empty() {
        *self = Self::default();
        return false;
    }

    let selected_item_id = self.selected_item_id();
    let selected_missing = selected_item_id.is_some_and(|id| !history_ids.contains(&id));
    if selected_missing || self.should_start_new_session(now) {
        self.start_session(history_ids);
    } else {
        self.retain_existing_ids(history_ids);
    }
    !self.order.is_empty()
}

pub fn resolve_slot(&mut self, slot: u8, history_ids: &[i64]) -> QuickPasteCursorResolution {
    self.resolve_slot_at(slot, history_ids, Instant::now())
}

fn resolve_slot_at(
    &mut self,
    slot: u8,
    history_ids: &[i64],
    now: Instant,
) -> QuickPasteCursorResolution {
    if !self.prepare_session(history_ids, now) {
        return QuickPasteCursorResolution::Empty;
    }

    let index = usize::from(slot.saturating_sub(1));
    let Some(item_id) = self.order.get(index).copied() else {
        self.last_used_at = Some(now);
        return QuickPasteCursorResolution::Empty;
    };
    self.offset = Some(index);
    self.last_used_at = Some(now);
    QuickPasteCursorResolution::Item(item_id)
}
```

Update `resolve_at` so it calls `prepare_session` and no longer calls `merge_new_ids`:

```rust
if !self.prepare_session(history_ids, now) {
    return QuickPasteCursorResolution::Empty;
}
```

Remove `merge_new_ids` if no longer used.

Update `resolve_quick_history_item` to build `history` from `get_recent_history(total)` rather than `get_history(total)`.

Update `paste_recent_history_slot_item` so it resolves the slot through `state.quick_paste_cursor_mut(...)` and then reads the selected item from the recent-active history list before calling `commands::paste_item_impl`.

In `src-tauri/src/commands.rs`, update `set_quick_paste_cursor_impl` to anchor against the same recent-active order:

```rust
let history_ids = state
    .repository()
    .get_recent_history(total)?
    .into_iter()
    .map(|item| item.id)
    .collect::<Vec<_>>();
```

- [ ] **Step 4: Add repository list method required by hotkeys**

In `src-tauri/src/database/repository.rs`, add:

```rust
pub fn get_recent_history(&self, limit: i64) -> AppResult<Vec<ClipboardItem>> {
    let conn = self.conn()?;
    let sql = format!(
        "SELECT {CLIPBOARD_ITEM_SUMMARY_COLUMNS} FROM clipboard_items
         ORDER BY {RECENT_HISTORY_ORDER}
         LIMIT ?1"
    );
    query_items(&conn, &sql, params![limit])
}
```

Use this method anywhere shortcut code needs the recent-active order without pinned priority.

- [ ] **Step 5: Run hotkey tests to verify they pass**

Run the same `cargo test` command from Step 2.

Expected: targeted hotkey tests pass.

- [ ] **Step 6: Commit shortcut snapshot behavior**

```powershell
git add src-tauri\src\hotkeys.rs src-tauri\src\commands.rs src-tauri\src\database\repository.rs
git commit -m "fix: stabilize recent history shortcuts with snapshots"
```

---

### Task 3: Renderer Store Recent-Active Sorting

**Files:**
- Modify: `src/renderer/src/store/clipboardStore.ts`
- Create: `src/renderer/src/store/__tests__/clipboardStore.test.ts`

- [ ] **Step 1: Write failing store tests**

Create `src/renderer/src/store/__tests__/clipboardStore.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { ClipboardItem } from '@shared/types';
import { useClipboardStore } from '@/store/clipboardStore';

function item(id: number, overrides: Partial<ClipboardItem> = {}): ClipboardItem {
  return {
    id,
    content: `item ${id}`,
    contentType: 'text',
    contentHash: `hash-${id}`,
    preview: `item ${id}`,
    metadata: {},
    filePath: null,
    imageData: null,
    createdAt: 1_700_000_000_000 + id,
    lastUsedAt: null,
    useCount: 0,
    isPinned: false,
    isFavorite: false,
    ...overrides
  };
}

describe('clipboardStore sorting', () => {
  beforeEach(() => {
    useClipboardStore.setState({
      items: [],
      selectedType: 'all',
      selectedItemId: null,
      searchQuery: '',
      settings: null
    });
  });

  it('sorts pinned first and then by recent active time', () => {
    useClipboardStore.getState().setItems([
      item(1, { createdAt: 100, lastUsedAt: 500 }),
      item(2, { createdAt: 400 }),
      item(3, { createdAt: 50, lastUsedAt: 200, isPinned: true })
    ]);

    expect(useClipboardStore.getState().items.map((entry) => entry.id)).toEqual([3, 1, 2]);
  });

  it('upsert moves a recently used item to the top of its pinned group', () => {
    useClipboardStore.getState().setItems([
      item(1, { createdAt: 100 }),
      item(2, { createdAt: 300 })
    ]);

    useClipboardStore.getState().upsertItem(item(1, { createdAt: 100, lastUsedAt: 500, useCount: 1 }));

    expect(useClipboardStore.getState().items.map((entry) => entry.id)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run store tests to verify they fail**

Run:

```powershell
pnpm vitest run src/renderer/src/store/__tests__/clipboardStore.test.ts
```

Expected: tests fail because current store sorting only uses `createdAt`.

- [ ] **Step 3: Implement store sorting**

Update `src/renderer/src/store/clipboardStore.ts`:

```ts
function activeAt(item: ClipboardItem): number {
  return item.lastUsedAt ?? item.createdAt;
}

function sortItems(items: ClipboardItem[]): ClipboardItem[] {
  return [...items].sort((a, b) => {
    if (a.isPinned !== b.isPinned) {
      return Number(b.isPinned) - Number(a.isPinned);
    }
    const activeDiff = activeAt(b) - activeAt(a);
    if (activeDiff !== 0) {
      return activeDiff;
    }
    const createdDiff = b.createdAt - a.createdAt;
    if (createdDiff !== 0) {
      return createdDiff;
    }
    return b.id - a.id;
  });
}
```

- [ ] **Step 4: Run store tests to verify they pass**

Run:

```powershell
pnpm vitest run src/renderer/src/store/__tests__/clipboardStore.test.ts
```

Expected: store tests pass.

- [ ] **Step 5: Run ClipboardList tests affected by ordering**

Run:

```powershell
pnpm vitest run src/renderer/src/components/__tests__/ClipboardList.test.tsx
```

Expected: ClipboardList tests pass. If a test expected the old selected item and the fixture now intentionally uses `lastUsedAt`, update the fixture or assertion to match recent-active behavior.

- [ ] **Step 6: Commit renderer sorting**

```powershell
git add src\renderer\src\store\clipboardStore.ts src\renderer\src\store\__tests__\clipboardStore.test.ts
git commit -m "fix: sort renderer history by recent activity"
```

---

### Task 4: Full Verification

**Files:**
- No planned source edits.

- [ ] **Step 1: Run TypeScript checks**

```powershell
pnpm typecheck
```

Expected: exit code 0.

- [ ] **Step 2: Run renderer tests**

```powershell
pnpm test
```

Expected: all Vitest tests pass.

- [ ] **Step 3: Run Rust formatting check**

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo fmt --manifest-path src-tauri\Cargo.toml --check
```

Expected: exit code 0.

- [ ] **Step 4: Run Rust tests**

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo test --manifest-path src-tauri\Cargo.toml -j 1
```

Expected: all Rust tests pass.

- [ ] **Step 5: Run Rust clippy**

```powershell
$env:RUSTUP_HOME='D:\rj\rustup'
$env:CARGO_HOME='D:\rj\cargo'
$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
$env:PATH='D:\rj\cargo\bin;' + $env:PATH
cargo clippy --manifest-path src-tauri\Cargo.toml -j 1 -- -D warnings
```

Expected: exit code 0.

- [ ] **Step 6: Run whitespace and encoding checks**

```powershell
git diff --check
$paths = @(
  'src-tauri\src\database\repository.rs',
  'src-tauri\src\hotkeys.rs',
  'src-tauri\src\commands.rs',
  'src\renderer\src\store\clipboardStore.ts',
  'src\renderer\src\store\__tests__\clipboardStore.test.ts',
  'docs\superpowers\plans\2026-06-29-recent-active-history-snapshot.md'
)
foreach ($path in $paths) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
    throw "$path has UTF-8 BOM"
  }
}
```

Expected: no whitespace errors and no UTF-8 BOM.

- [ ] **Step 7: Commit any verification-only adjustments**

If formatting changes were produced by `cargo fmt`, commit them:

```powershell
git add src-tauri\src\database\repository.rs src-tauri\src\hotkeys.rs src-tauri\src\commands.rs
git commit -m "chore: format recent history snapshot changes"
```

If there are no changes, skip this commit.

---

## Manual Verification After Build

These require a real Windows desktop session:

- Copy several text items, then use an older item from the main list. It should move to the top of its pinned group immediately.
- Use `Ctrl+Alt+1/2/3` repeatedly within about 1.5 seconds. The same slot should keep pointing to the same item during the short snapshot window.
- Wait more than 1.5 seconds after using a slot. The next slot trigger should resolve against the latest recent-active order.
- Use quick previous/next repeatedly. The sequence should not jump around just because a copied item moved to the top of the main list.
