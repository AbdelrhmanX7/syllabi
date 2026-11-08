/** `plural(1, "miss", "misses")` → "miss"; any other count → "misses". Never "miss(es)". */
export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
