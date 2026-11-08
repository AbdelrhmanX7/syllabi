// The due date a student should act on: an announcement can move a Canvas deadline, and the backend
// sends that as `effectiveDueAt` (with `dueChangedBy`). `dueAt` stays the Canvas value.

interface Dated {
  dueAt?: string | null;
  effectiveDueAt?: string | null;
}

export const effectiveDue = (item: Dated): string | null => item.effectiveDueAt ?? item.dueAt ?? null;

/** Undated items go last in either direction. */
export function sortByEffectiveDue<T extends Dated>(items: readonly T[], direction: 'asc' | 'desc' = 'asc'): T[] {
  const sign = direction === 'asc' ? 1 : -1;

  return [...items].sort((a, b) => {
    const x = effectiveDue(a);
    const y = effectiveDue(b);

    if (!x || !y) return x ? -1 : y ? 1 : 0;

    return sign * (Date.parse(x) - Date.parse(y));
  });
}
