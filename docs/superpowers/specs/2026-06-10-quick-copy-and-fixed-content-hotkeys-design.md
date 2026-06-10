# ClipVault 快速复制与固定快捷内容设计 Spec

**Status:** Approved for planning  
**Date:** 2026-06-10  
**Owner:** xxsby  
**Scope:** 调整历史上一项/下一项快捷键行为，并新增可配置快捷键的固定内容粘贴能力。

## 1. 背景

ClipVault 当前的 `quickPastePrev` / `quickPasteNext` 会根据历史游标选中上一条或下一条历史记录，然后写入系统剪贴板并模拟 `Ctrl+V`。xxsby 希望这个历史轮转行为只把内容复制到剪贴板，不再自动粘贴。

另一个新增工作流是“固定快捷内容”：用户可以保存一段固定文本 A，并绑定自定义快捷键，例如 `Ctrl+1`。触发快捷键时，ClipVault 直接把 A 写入系统剪贴板并模拟 `Ctrl+V`。该行为不读取、不拼接当前剪贴板内容 B，也不受当前复制内容影响。

`Ctrl+鼠标滚轮` 与浏览器缩放的冲突本次不改，继续保持现有行为和默认设置。

## 2. 目标

- 历史上一项/下一项快捷键只复制历史内容到剪贴板，不模拟粘贴。
- 历史上一项/下一项继续复用现有历史游标、使用统计和 HUD 反馈。
- 新增固定快捷内容列表，支持创建、编辑、删除、启用/停用。
- 每条固定快捷内容可配置标题、正文内容和快捷键。
- 固定快捷内容触发时直接粘贴该固定内容，不拼接当前剪贴板内容。
- 固定快捷内容独立于普通剪贴板历史，不参与历史清理、历史搜索、上一项/下一项轮转。
- 快捷键冲突检测覆盖常规快捷键、历史轮转快捷键和固定快捷内容快捷键。

## 3. 非目标

- 不修改 `Ctrl+鼠标滚轮` 的默认修饰键、作用范围或 hook 逻辑。
- 不做 A+B 自动拼接。
- 不把固定快捷内容加入普通历史记录。
- 不支持图片、文件或富文本固定内容，本次仅支持文本。
- 不新增云同步或跨设备同步。

## 4. 方案选择

### 推荐方案：独立固定内容表 + 统一热键注册

新增 `fixed_contents` 表保存固定快捷内容。Rust 启动和快捷键更新时读取普通热键与固定内容热键，并统一注册到 Tauri global shortcut。触发固定内容热键时，写入文本剪贴板、隐藏主面板、模拟 `Ctrl+V`，然后显示 HUD。

优点是边界清晰：固定内容不是历史记录，也不是历史置顶项；不会被清理策略影响。缺点是需要新增 Tauri commands、权限、前端设置 UI 和数据库迁移。

### 备选方案 A：复用历史记录置顶项

把固定内容作为普通文本历史条目并标记置顶，再额外绑定快捷键。优点是数据结构少；缺点是会和历史搜索、清理、去重、置顶语义互相影响，后续容易误删或误展示。

### 备选方案 B：把固定内容写进 settings JSON

把固定内容数组放进 settings。优点是实现最少；缺点是缺少独立约束、查询和更新粒度，快捷键冲突、删除和排序会更脆弱。

选择推荐方案。

## 5. 后端设计

### 数据模型

新增模型 `FixedContent`：

- `id: i64`
- `title: String`
- `content: String`
- `hotkey: String`
- `enabled: bool`
- `created_at: i64`
- `updated_at: i64`
- `last_used_at: Option<i64>`
- `use_count: i64`

新增输入模型：

- `FixedContentInput` 用于创建和更新，包含 `title`、`content`、`hotkey`、`enabled`。
- 标题和内容需要 trim 后校验非空。
- 快捷键需要 trim 后用现有 global shortcut parser 校验。

### 数据库

新增表：

```sql
CREATE TABLE IF NOT EXISTS fixed_contents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  hotkey TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count INTEGER DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fixed_contents_hotkey_enabled
ON fixed_contents(hotkey)
WHERE enabled = 1;
```

迁移需要兼容已有数据库。新表不会影响 `clipboard_items`、FTS、黑名单和 settings。

### Commands

新增 Tauri commands：

- `list_fixed_contents() -> Vec<FixedContent>`
- `create_fixed_content(input: FixedContentInput) -> FixedContent`
- `update_fixed_content(id, input) -> FixedContent`
- `delete_fixed_content(id) -> bool`

这些命令需要加入 `src-tauri/permissions/clipvault.toml` 和 `src-tauri/src/lib.rs` 的 invoke handler。

创建、更新、删除固定内容后，需要重新注册键盘快捷键。注册失败时不能持久化部分失败状态；更新流程应先验证候选快捷键全集，再写库并刷新注册。若刷新注册失败，需要回滚到变更前的快捷键集合。

### 热键行为

现有 `HotkeyAction::QuickPaste` 保留游标逻辑，但执行动作改为 `copy_item_impl(... paste::write_item_to_clipboard)`，不再调用 `write_clipboard_and_paste`。HUD 文案调整为“已复制上一项/下一项”一类语义。

新增 `HotkeyAction::FixedContent(id)`。触发时：

1. 读取固定内容。
2. 如果不存在或已禁用，直接返回。
3. 写入系统文本剪贴板。
4. 隐藏主窗口。
5. 模拟 `Ctrl+V`。
6. 更新该固定内容 `last_used_at` 和 `use_count`。
7. 发送 HUD 成功提示。

固定内容热键不更新普通历史 revision，除非前端需要刷新固定内容列表统计；固定内容列表可单独在设置页重新拉取。

### 冲突校验

冲突来源包括：

- `HotkeySettings` 中的常规快捷键。
- `quickPastePrev` / `quickPasteNext`。
- 所有启用的固定快捷内容。

同一个快捷键不能绑定给两个启用命令。禁用的固定内容不占用快捷键。

## 6. 前端设计

在设置面板的“快捷键”页新增“固定快捷内容”区域：

- 列表展示标题、快捷键、启用状态和操作按钮。
- 支持新增、编辑、删除。
- 正文使用多行输入。
- 快捷键录制复用现有 `startHotkeyRecording` / `formatHotkeyLabel` 交互模式。
- 保存前调用后端校验；后端作为最终约束来源。

现有“快速粘贴”分组文案需要改为“历史快速复制”或等价中文，描述从“直接粘贴”改为“复制到剪贴板”。

共享类型 `src/shared/types.ts` 需要新增 `FixedContent`、`FixedContentInput` 和 API 方法声明。

## 7. 错误处理

- 固定内容标题为空：返回清晰错误。
- 固定内容正文为空：返回清晰错误。
- 快捷键格式非法：返回清晰错误。
- 快捷键冲突：返回冲突快捷键和绑定来源。
- 固定内容触发时写剪贴板或模拟粘贴失败：不更新使用统计，并记录 warn 日志。
- 删除不存在固定内容：返回 `false` 或等价无副作用结果。

## 8. 测试计划

Rust：

- 历史上一项/下一项调用复制路径，不调用模拟粘贴路径。
- 固定内容 CRUD 校验标题、正文、快捷键。
- 固定内容快捷键与普通快捷键冲突会被拒绝。
- 禁用固定内容不参与快捷键冲突。
- 固定内容触发成功后更新使用统计。
- 固定内容触发失败时不更新使用统计。

前端：

- `tauriApi` 映射固定内容 commands。
- 设置面板可以渲染固定内容列表。
- 新增/编辑固定内容会调用正确 API。
- 快捷键页文案反映“历史快速复制”。

手工验证：

- `Ctrl+Alt+Left/Right` 只复制历史内容，不自动粘贴。
- 固定内容快捷键写入 A 并自动粘贴 A。
- 固定内容快捷键不拼接当前剪贴板内容。
- 修改固定内容后，新快捷键立即生效，旧快捷键失效。
- `Ctrl+鼠标滚轮` 行为保持本次改动前一致。
