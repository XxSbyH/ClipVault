declare module 'react-window' {
  import * as React from 'react';

  export interface ListChildComponentProps<T = unknown> {
    index: number;
    style: React.CSSProperties;
    data: T;
    isScrolling?: boolean;
  }

  export interface FixedSizeListProps<T = unknown> {
    height: number;
    width: number | string;
    itemCount: number;
    itemSize: number;
    itemData?: T;
    children: React.ComponentType<ListChildComponentProps<T>>;
  }

  export class FixedSizeList<T = unknown> extends React.Component<FixedSizeListProps<T>> {
    scrollToItem(index: number, align?: 'auto' | 'smart' | 'center' | 'end' | 'start'): void;
  }
}
