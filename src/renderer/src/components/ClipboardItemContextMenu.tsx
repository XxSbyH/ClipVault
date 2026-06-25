import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Edit3, ListOrdered, Plus, Trash2, Wand2 } from 'lucide-react';
import type { ClipboardItem, SpecialPasteAction } from '@shared/types';
import { cn } from '@/lib/utils';

const TEXT_CONTENT_TYPES: Array<ClipboardItem['contentType']> = ['text', 'url', 'code', 'color', 'email'];
const MENU_WIDTH = 224;
const MENU_HEIGHT = 224;
const SUBMENU_WIDTH = 252;
const VIEWPORT_MARGIN = 8;

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

type Submenu = 'specialPaste' | 'sort' | null;

function clampPosition(x: number, y: number) {
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - MENU_HEIGHT - VIEWPORT_MARGIN);

  return {
    left: Math.min(Math.max(VIEWPORT_MARGIN, x), maxLeft),
    top: Math.min(Math.max(VIEWPORT_MARGIN, y), maxTop)
  };
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
  const [submenu, setSubmenu] = useState<Submenu>(null);
  const isTextLike = TEXT_CONTENT_TYPES.includes(item.contentType);
  const menuStyle = useMemo(() => clampPosition(x, y), [x, y]);
  const submenuOpensLeft = menuStyle.left + MENU_WIDTH + SUBMENU_WIDTH + VIEWPORT_MARGIN > window.innerWidth;

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

  const openSpecialPaste = () => {
    if (isTextLike) {
      setSubmenu('specialPaste');
    }
  };

  const menu = (
    <div
      role="menu"
      aria-label="历史项操作"
      className="fixed z-[70] w-56 rounded-lg border border-slate-200 bg-white p-1.5 text-sm shadow-2xl shadow-slate-950/15"
      style={menuStyle}
      onContextMenu={(event) => event.preventDefault()}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseLeave={() => setSubmenu(null)}
    >
      <MenuButton
        disabled={!isTextLike}
        onClick={openSpecialPaste}
        onMouseEnter={openSpecialPaste}
        ariaHasPopup
      >
        <Wand2 className="h-3.5 w-3.5 text-teal-700" />
        <span>特殊粘贴</span>
        <ChevronRight className="ml-auto h-3.5 w-3.5 text-slate-400" />
      </MenuButton>

      <MenuButton
        disabled={!isTextLike}
        onClick={() => onEdit(item)}
        onMouseEnter={() => setSubmenu(null)}
      >
        <Edit3 className="h-3.5 w-3.5 text-sky-700" />
        <span>编辑内容</span>
      </MenuButton>

      <MenuButton
        disabled={!isTextLike}
        onClick={() => onAddFixedContent(item)}
        onMouseEnter={() => setSubmenu(null)}
      >
        <Plus className="h-3.5 w-3.5 text-emerald-700" />
        <span>添加为固定内容</span>
      </MenuButton>

      <div className="my-1 h-px bg-slate-100" />

      <MenuButton
        disabled
        onMouseEnter={() => setSubmenu('sort')}
        ariaHasPopup
      >
        <ListOrdered className="h-3.5 w-3.5 text-slate-400" />
        <span>剪切项排序（开发中）</span>
        <ChevronRight className="ml-auto h-3.5 w-3.5 text-slate-300" />
      </MenuButton>

      <div className="my-1 h-px bg-slate-100" />

      <MenuButton
        danger
        onClick={() => onDelete(item.id)}
        onMouseEnter={() => setSubmenu(null)}
      >
        <Trash2 className="h-3.5 w-3.5" />
        <span>删除</span>
      </MenuButton>

      {submenu === 'specialPaste' && isTextLike ? (
        <SubmenuPanel
          ariaLabel="特殊粘贴选项"
          opensLeft={submenuOpensLeft}
          className="top-1"
        >
          {SPECIAL_PASTE_ITEMS.map((entry) => (
            <MenuButton
              key={entry.action}
              compact
              onClick={() => onSpecialPaste(item, entry.action)}
            >
              <span>{entry.label}</span>
            </MenuButton>
          ))}
        </SubmenuPanel>
      ) : null}

      {submenu === 'sort' ? (
        <SubmenuPanel
          ariaLabel="剪切项排序选项"
          opensLeft={submenuOpensLeft}
          className="top-[118px]"
        >
          {SORT_ITEMS.map((label) => (
            <MenuButton
              key={label}
              compact
              disabled
            >
              <span>{label}</span>
            </MenuButton>
          ))}
        </SubmenuPanel>
      ) : null}
    </div>
  );

  return createPortal(menu, document.body);
}

function SubmenuPanel({
  ariaLabel,
  children,
  className,
  opensLeft
}: {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  opensLeft: boolean;
}): JSX.Element {
  return (
    <div
      role="menu"
      aria-label={ariaLabel}
      className={cn(
        'absolute z-[71] w-[252px] rounded-lg border border-slate-200 bg-white p-1.5 shadow-2xl shadow-slate-950/15',
        opensLeft ? 'right-full mr-1' : 'left-full ml-1',
        className
      )}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

function MenuButton({
  ariaHasPopup = false,
  children,
  compact = false,
  danger = false,
  disabled = false,
  onClick,
  onMouseEnter
}: {
  ariaHasPopup?: boolean;
  children: ReactNode;
  compact?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  onMouseEnter?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      aria-haspopup={ariaHasPopup ? 'menu' : undefined}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors',
        compact ? 'min-h-8 py-1.5' : 'h-9',
        danger ? 'text-red-600 hover:bg-red-50' : 'text-slate-700 hover:bg-teal-50 hover:text-teal-900',
        disabled && 'cursor-not-allowed text-slate-400 opacity-60 hover:bg-transparent hover:text-slate-400'
      )}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      {children}
    </button>
  );
}
