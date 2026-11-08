// IMPORTANT: HeroUI star export must come FIRST. The local da-v2 component
// re-exports below intentionally shadow the corresponding HeroUI exports so
// every consumer of `@repo/ui` automatically gets the scrapbook visuals.
export * from '@heroui/react';

export { cn } from './cn';
export { lockBodyScroll } from './body-scroll-lock';
export { heroUIThemeConfig } from './theme';
export { heroUIStudioAppThemeConfig } from './studio-theme';

// da-v2 design system — overrides MUST come AFTER the heroui star export.
export { Button } from './components/Button';
export type { ButtonProps } from './components/Button';

export { Card, CardHeader, CardBody, CardFooter, Tape, Pin, HolePunch } from './components/Card';
export { ClayButton } from './components/ClayButton';
export { clayVars, CLAY_FILL, CLAY_LABEL, CLAY_RADIUS, CLAY_RIM, clayKindFor } from './components/clay';
export type { ClayColor, ClayKind, ClayOptions } from './components/clay';
export type { ClayButtonProps } from './components/ClayButton';
export type {
  CardProps,
  CardShadowColor,
  TapeColor,
  TapeProps,
  PinProps,
  HolePunchProps,
  HolePunchSide,
} from './components/Card';

export { Chip } from './components/Chip';
export type { ChipProps, ChipVariant } from './components/Chip';

export { Input } from './components/Input';
export type { InputProps, InputVariant } from './components/Input';

export { Textarea } from './components/Textarea';
export type { TextareaProps, TextareaVariant } from './components/Textarea';

export { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure } from './components/Modal';
export type { ModalProps, ModalContentProps } from './components/Modal';

export { Spinner } from './components/Spinner';
export type { SpinnerProps } from './components/Spinner';

export { Skeleton } from './components/Skeleton';
export type { SkeletonProps } from './components/Skeleton';

// ASCII/Unicode "thinking" indicator — no HeroUI counterpart, purely additive.
export { Thinking, THINKING_FRAMES, THINKING_FRAME_WIDTH, THINKING_VARIANTS } from './components/Thinking';
export type { ThinkingProps, ThinkingVariant } from './components/Thinking';

export { Avatar } from './components/Avatar';
export type { AvatarProps } from './components/Avatar';

export { Switch } from './components/Switch';
export type { SwitchProps } from './components/Switch';

export { Checkbox } from './components/Checkbox';
export type { CheckboxProps } from './components/Checkbox';

// Phase 2 Round 1 — additional shadows over HeroUI.
export { Select, SelectItem } from './components/Select';
export type { SelectProps, SelectItemProps, SelectVariant } from './components/Select';

export { Tabs, Tab } from './components/Tabs';
export type { TabsProps, TabProps, TabsVariant, TabsPlacement } from './components/Tabs';

export { RadioGroup, Radio } from './components/RadioGroup';
export type { RadioGroupProps, RadioProps } from './components/RadioGroup';

export { Progress, CircularProgress } from './components/Progress';
export type { ProgressProps, CircularProgressProps } from './components/Progress';

export { Pagination } from './components/Pagination';
export type { PaginationProps, PaginationVariant } from './components/Pagination';

// Phase 2 Round 2 — portal-based components.
export { Toast, ToastProvider, addToast, closeToast, closeAll } from './components/Toast';
// HeroUI re-exports `ToastProvider` only; some downstream code aliases it as
// `Toaster`. Provide the alias so call sites are happy either way.
export { ToastProvider as Toaster } from './components/Toast';
export type { ToastProps, ToastProviderProps, ToastPlacement, ToastVariant, ToastClassNames } from './components/Toast';

export { Tooltip } from './components/Tooltip';
export type { TooltipProps, TooltipPlacement, TooltipColor } from './components/Tooltip';

// Phase 2 Round 3 — Popover, Drawer, Accordion.
export { Popover, PopoverTrigger, PopoverContent } from './components/Popover';
export type {
  PopoverProps,
  PopoverTriggerProps,
  PopoverContentProps,
  PopoverPlacement,
  PopoverBackdrop,
  PopoverTriggerType,
  PopoverShadow,
  PopoverClassNames,
} from './components/Popover';

export { Drawer, DrawerContent, DrawerHeader, DrawerBody, DrawerFooter } from './components/Drawer';
export type {
  DrawerProps,
  DrawerContentProps,
  DrawerPlacement,
  DrawerSize,
  DrawerRadius,
  DrawerBackdrop,
  DrawerScrollBehavior,
  DrawerClassNames,
} from './components/Drawer';

export { Accordion, AccordionItem } from './components/Accordion';
export type {
  AccordionProps,
  AccordionItemProps,
  AccordionVariant,
  AccordionSelectionMode,
  AccordionSelectionBehavior,
  AccordionClassNames,
  AccordionItemClassNames,
  AccordionIndicator,
} from './components/Accordion';

// Phase 2 Round 4 — Table compound component.
export { Table, TableHeader, TableColumn, TableBody, TableRow, TableCell } from './components/Table';
export type {
  TableProps,
  TableHeaderProps,
  TableColumnProps,
  TableBodyProps,
  TableRowProps,
  TableCellProps,
  TableClassNames,
  TableSelection,
  TableSelectionMode,
  TableSelectionBehavior,
  TableSortDescriptor,
  TableSortDirection,
  TableLoadingState,
} from './components/Table';

// Phase 2 Round 5 — Dropdown family, Divider, Slider, ScrollShadow, Alert, Badge.
export { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSection } from './components/Dropdown';
export type {
  DropdownProps,
  DropdownPlacement,
  DropdownTriggerType,
  DropdownTriggerProps,
  DropdownMenuProps,
  DropdownMenuClassNames,
  DropdownSectionProps,
  DropdownItemProps,
  DropdownItemClassNames,
} from './components/Dropdown';

export { Divider } from './components/Divider';
export type { DividerProps, DividerOrientation } from './components/Divider';

export { Slider } from './components/Slider';
export type { SliderProps, SliderClassNames, SliderValue } from './components/Slider';

export { ScrollShadow } from './components/ScrollShadow';
export type {
  ScrollShadowProps,
  ScrollShadowOrientation,
  ScrollShadowVisibility,
  ScrollShadowClassNames,
} from './components/ScrollShadow';

export { Alert } from './components/Alert';
export type { AlertProps, AlertVariant, AlertClassNames } from './components/Alert';

export { Badge } from './components/Badge';
export type { BadgeProps, BadgePlacement, BadgeShape, BadgeVariant } from './components/Badge';

// Phase 2 Round 6 — remaining shadowed components.
export { Link } from './components/Link';
export type { LinkProps, LinkColor, LinkSize, LinkUnderline } from './components/Link';

export { Breadcrumbs, BreadcrumbItem } from './components/Breadcrumbs';
export type {
  BreadcrumbsProps,
  BreadcrumbItemProps,
  BreadcrumbsClassNames,
  BreadcrumbItemClassNames,
  BreadcrumbsVariant,
} from './components/Breadcrumbs';

export { Autocomplete, AutocompleteItem } from './components/Autocomplete';
export type {
  AutocompleteProps,
  AutocompleteItemProps,
  AutocompleteVariant,
  AutocompleteMenuTrigger,
} from './components/Autocomplete';

export { AvatarGroup } from './components/AvatarGroup';
export type { AvatarGroupProps } from './components/AvatarGroup';

export { Code } from './components/Code';
export type { CodeProps, CodeColor, CodeSize, CodeRadius } from './components/Code';

export { Form, FormProvider, useFormContext, getFieldError } from './components/Form';
export type {
  FormProps,
  FormProviderProps,
  FormContextValue,
  FormValidationBehavior,
  FormValidationErrors,
} from './components/Form';

export { Image } from './components/Image';
export type { ImageProps, ImageRadius, ImageShadow } from './components/Image';

export { Kbd } from './components/Kbd';
export type { KbdProps, KbdKey } from './components/Kbd';

export { Listbox, ListboxItem, ListboxSection } from './components/Listbox';
export type {
  ListboxProps,
  ListboxItemProps,
  ListboxSectionProps,
  ListboxClassNames,
  ListboxItemClassNames,
  ListboxVariant,
  ListboxSelectionMode,
} from './components/Listbox';

export { Menu, MenuItem, MenuSection } from './components/Menu';
export type { MenuProps, MenuItemProps, MenuSectionProps, MenuClassNames, MenuItemClassNames } from './components/Menu';

export {
  Navbar,
  NavbarBrand,
  NavbarContent,
  NavbarItem,
  NavbarMenu,
  NavbarMenuItem,
  NavbarMenuToggle,
} from './components/Navbar';
export type {
  NavbarProps,
  NavbarBrandProps,
  NavbarContentProps,
  NavbarItemProps,
  NavbarMenuProps,
  NavbarMenuItemProps,
  NavbarMenuToggleProps,
  NavbarClassNames,
  NavbarMaxWidth,
  NavbarPosition,
} from './components/Navbar';

export { NumberInput } from './components/NumberInput';
export type { NumberInputProps, NumberInputVariant } from './components/NumberInput';

export { Snippet } from './components/Snippet';
export type { SnippetProps, SnippetVariant, SnippetColor, SnippetSize, SnippetRadius } from './components/Snippet';

export { Spacer } from './components/Spacer';
export type { SpacerProps, SpacerSpace } from './components/Spacer';

export { User } from './components/User';
export type { UserProps } from './components/User';

// Icon — hand-drawn registry + lucide wrapper + animation props.
export { Icon, ICON_REGISTRY } from './components/Icon';
export type { IconProps, IconHoverAnimation, IconTrigger, RegisteredIconName } from './components/Icon';


// ScrapbookProvider — app-level defaults for the scrapbook visuals (currently
// the surface-tilt opt-out). Not mounting it leaves an app exactly as it was.
export { ScrapbookProvider, useScrapbookConfig, useTiltDisabled } from './components/ScrapbookProvider';
export type { ScrapbookConfig, ScrapbookProviderProps } from './components/ScrapbookProvider';

// Tokens (constants + types) — apps can import { INK, PRIMARY, pickRotation, ... } from '@repo/ui'
export * from './components/tokens';
