import { useEffect, type ReactNode } from 'react';
import { ChevronRight, Edit3, Plus, Trash2, Wand2 } from 'lucide-react';
import type { ClipboardItem, SpecialPasteAction } from '@shared/types';
import { cn } from '@/lib/utils';

const TEXT_CONTENT_TYPES: Array<ClipboardItem['contentType']> = ['text', 'url', 'code', 'color', 'email'];

const SPECIAL_PASTE_ITEMS: Array<{ action: SpecialPasteAction; label: string }> = [
  { action: 'upper', label: '全部大写' },
  { action: 'lower', label: '全部小写' },
  { action: 'plain', label: '仅粘贴纯文本' },
  { action: 'camel', label: '驼峰命名法' },
  { action: 'capitalize', label: '首字母大写' },
  { action: 'sentence', label: '句首字母大写' },
  { action: 'removeNewlines', label: '移除换行符' },
  { action: 'appendNewline', label: '粘贴并添加一个换行符' },
  { action: 'appendCurrentTime', label: '粘贴并添加显示当前时间' }
];

const SORT_ITEMS = ['上移（开发中）', '下移（开发中）', '固定到顶部（开发中）', '移动到底部（开发中）'];

interface ClipboardItemContextMenuProps {
  item: ClipboardItem;
  x: number;
  y: number;
  onClose: () => void;
  onSpecialPaste: (item: ClipboardItem, action: SpecialPasteAction) => void;
  onEdit: (item: ClipboardItem) => void;
  onAddFixedContent: (item: ClipboardItem) => void;
  onDelete: (id: number) => void;
}

export function ClipboardItemContextMenu({
  item,
  x,
  y,
  onClose,
  onSpecialPaste,
  onEdit,
  onAddFixedContent,
  onDelete
}: ClipboardItemContextMenuProps): JSX.Element {
  const isTextLike = TEXT_CONTENT_TYPES.includes(item.contentType);

  useEffect(() => {
    const close = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const menuStyle = {
    left: Math.min(x, window.innerWidth - 292),
    top: Math.min(y, window.innerHeight - 472)
  };

  return (
    <div
      role="menu"
      aria-label="历史项操作"
      className="fixed z-[70] w-72 rounded-lg border border-slate-200 bg-white p-1.5 text-sm shadow-2xl shadow-slate-950/15"
      style={menuStyle}
      onContextMenu={(event) => event.preventDefault()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="px-2 py-1.5 text-[11px] font-semibold uppercase text-teal-700">特殊粘贴</div>
      <div className="grid grid-cols-1 gap-0.5">
        {SPECIAL_PASTE_ITEMS.map((entry) => (
          <MenuButton
            key={entry.action}
            disabled={!isTextLike}
            onClick={() => onSpecialPaste(item, entry.action)}
          >
            <Wand2 className="h-3.5 w-3.5" />
            <span>{entry.label}</span>
          </MenuButton>
        ))}
      </div>

      <div className="my-1 h-px bg-slate-100" />
      <MenuButton
        disabled={!isTextLike}
        onClick={() => onEdit(item)}
      >
        <Edit3 className="h-3.5 w-3.5" />
        <span>编辑内容</span>
      </MenuButton>
      <MenuButton
        disabled={!isTextLike}
        onClick={() => onAddFixedContent(item)}
      >
        <Plus className="h-3.5 w-3.5" />
        <span>添加为固定内容</span>
      </MenuButton>

      <div className="my-1 h-px bg-slate-100" />
      <div className="px-2 py-1.5 text-[11px] font-semibold uppercase text-slate-400">
        剪切项排序（开发中）
      </div>
      {SORT_ITEMS.map((label) => (
        <MenuButton
          key={label}
          disabled
        >
          <ChevronRight className="h-3.5 w-3.5" />
          <span>{label}</span>
        </MenuButton>
      ))}

      <div className="my-1 h-px bg-slate-100" />
      <MenuButton
        danger
        onClick={() => onDelete(item.id)}
      >
        <Trash2 className="h-3.5 w-3.5" />
        <span>删除</span>
      </MenuButton>
    </div>
  );
}

function MenuButton({
  children,
  danger = false,
  disabled = false,
  onClick
}: {
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors',
        danger ? 'text-red-600 hover:bg-red-50' : 'text-slate-700 hover:bg-teal-50 hover:text-teal-900',
        disabled && 'cursor-not-allowed text-slate-400 opacity-60 hover:bg-transparent hover:text-slate-400'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
