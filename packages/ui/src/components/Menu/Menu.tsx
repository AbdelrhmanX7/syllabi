import React from 'react';

import type {
  ListboxClassNames,
  ListboxItemClassNames,
  ListboxItemProps,
  ListboxSectionProps,
  ListboxVariant,
} from '../Listbox/Listbox';
import { Listbox, ListboxItem, ListboxSection } from '../Listbox/Listbox';
import type { HeroUIColor } from '../tokens';

/**
 * da-v2 Menu / MenuItem / MenuSection — drop-in for HeroUI's Menu.
 *
 * Like Listbox but for ACTIONS — no persisted selection. Each click fires
 * `onAction(key)`. Often used inside a Popover (Dropdown does this); also
 * usable standalone.
 *
 *   <Menu aria-label='actions' onAction={(k) => ...}>
 *     <MenuSection title='File' showDivider>
 *       <MenuItem key='new' shortcut='⌘N'>New</MenuItem>
 *     </MenuSection>
 *     <MenuItem key='delete' color='danger'>Delete</MenuItem>
 *   </Menu>
 *
 * Implementation: thin wrapper around Listbox with `selectionMode='none'` forced.
 * MenuItem extends ListboxItem and passes `role='menuitem'` via spread so the
 * underlying <li> picks it up (overriding the default 'option').
 */

export interface MenuProps {
  'aria-label'?: string;
  children?: React.ReactNode | ((item: unknown) => React.ReactNode);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items?: Iterable<any>;
  disabledKeys?: Iterable<string>;
  onAction?: (key: string) => void;
  variant?: ListboxVariant;
  color?: HeroUIColor;
  autoFocus?: boolean | 'first' | 'last';
  shouldHighlightOnFocus?: boolean;
  shouldFocusWrap?: boolean;
  hideEmptyContent?: boolean;
  emptyContent?: React.ReactNode;
  topContent?: React.ReactNode;
  bottomContent?: React.ReactNode;
  className?: string;
  classNames?: ListboxClassNames;
  itemClasses?: ListboxItemClassNames;
  /** HeroUI compat — Menu has no persisted selection, but kept for parity. */
  closeOnSelect?: boolean;
  /** Pass-through for `dir`. */
  dir?: 'rtl' | 'ltr';
}

export function Menu(props: MenuProps) {
  const { closeOnSelect: _co, ...rest } = props;

  return <Listbox {...rest} selectionMode='none' />;
}

Menu.displayName = 'Menu';

/* ============================================================
   <MenuSection>
   Re-export of ListboxSection with displayName='MenuSection' so the
   Listbox child-walker recognizes both names.
   ============================================================ */

export type MenuSectionProps = ListboxSectionProps;

export function MenuSection(props: MenuSectionProps) {
  return <ListboxSection {...props} />;
}

MenuSection.displayName = 'MenuSection';

/* ============================================================
   <MenuItem>
   Wrapper around ListboxItem that forces role='menuitem' via the spread
   pass-through (rest props end up on the <li>). DisplayName='MenuItem' so
   Listbox's walker still injects __itemKey.
   ============================================================ */

export type MenuItemProps = ListboxItemProps;

export function MenuItem(props: MenuItemProps) {
  // role='menuitem' is forwarded through ListboxItem's `...rest` to the <li>,
  // overriding the default `role='option'`.
  return <ListboxItem {...props} role='menuitem' />;
}

MenuItem.displayName = 'MenuItem';

export type MenuClassNames = ListboxClassNames;
export type MenuItemClassNames = ListboxItemClassNames;
