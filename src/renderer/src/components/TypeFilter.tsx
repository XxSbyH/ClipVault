import type { FilterType } from '@shared/types';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useClipboardStore } from '@/store/clipboardStore';

const FILTERS: Array<{ value: FilterType; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
  { value: 'code', label: '代码' },
  { value: 'url', label: 'URL' },
  { value: 'favorite', label: '收藏' }
];

export function TypeFilter(): JSX.Element {
  const items = useClipboardStore((state) => state.items);
  const selectedType = useClipboardStore((state) => state.selectedType);
  const setSelectedType = useClipboardStore((state) => state.setSelectedType);

  const countByType = {
    all: items.length,
    text: items.filter((item) => item.contentType === 'text').length,
    image: items.filter((item) => item.contentType === 'image').length,
    code: items.filter((item) => item.contentType === 'code').length,
    url: items.filter((item) => item.contentType === 'url').length,
    favorite: items.filter((item) => item.isFavorite).length
  };

  return (
    <Tabs
      value={selectedType}
      onValueChange={(value) => setSelectedType(value as FilterType)}
      className="w-full"
    >
      <TabsList className="grid w-full grid-cols-6">
        {FILTERS.map((filter) => (
          <TabsTrigger
            key={filter.value}
            value={filter.value}
            className="flex items-center justify-center gap-1 px-1 text-xs"
          >
            <span>{filter.label}</span>
            <Badge className="px-1 py-0 text-[10px]">{countByType[filter.value]}</Badge>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
