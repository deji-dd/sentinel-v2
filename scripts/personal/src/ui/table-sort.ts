/**
 * Sortable, keyboard-operable tables.
 *
 * Both the crime category table and the company weekly ledger were fixed sorts —
 * the crime table was hard-sorted by efficiency with no way to ask "which crime
 * earns the most?" — and neither could be filtered. The tables are rendered as
 * template strings, so this module supplies the two pieces the markup needs: the
 * header attributes that make a column sortable and focusable, and the row
 * ordering.
 */

export type SortDirection = "asc" | "desc";

export interface SortState<Key extends string> {
	key: Key;
	direction: SortDirection;
}

/**
 * The state after a header is activated.
 *
 * Same column flips direction; a new column starts in the direction that makes
 * sense for it, which the caller supplies (numbers usually descending, dates and
 * names ascending).
 */
export function nextSortState<Key extends string>(
	current: SortState<Key>,
	key: Key,
	initialDirection: SortDirection = "desc",
): SortState<Key> {
	if (current.key === key) {
		return {
			key,
			direction: current.direction === "desc" ? "asc" : "desc",
		};
	}
	return { key, direction: initialDirection };
}

export type SortAccessors<Row, Key extends string> = Record<
	Key,
	(row: Row) => number | string
>;

/** Rows in `state`'s order. Strings compare case-insensitively. */
export function sortRows<Row, Key extends string>(
	rows: readonly Row[],
	state: SortState<Key>,
	accessors: SortAccessors<Row, Key>,
): Row[] {
	const accessor = accessors[state.key];
	if (!accessor) return [...rows];

	const factor = state.direction === "asc" ? 1 : -1;
	return [...rows].sort((a, b) => {
		const left = accessor(a);
		const right = accessor(b);
		if (typeof left === "string" || typeof right === "string") {
			return (
				String(left).localeCompare(String(right), undefined, {
					sensitivity: "base",
					numeric: true,
				}) * factor
			);
		}
		// Non-finite values (a missing ROI, say) sort last whichever way the column
		// is pointing, rather than jumping to the top on a descending sort.
		const leftFinite = Number.isFinite(left);
		const rightFinite = Number.isFinite(right);
		if (!leftFinite && !rightFinite) return 0;
		if (!leftFinite) return 1;
		if (!rightFinite) return -1;
		return (left - right) * factor;
	});
}

/**
 * Wires click and Enter/Space on every `th[data-sort]` inside `root`.
 *
 * Returns a cleanup function so a re-render can drop stale listeners; the tabs
 * replace their whole body on render, so the listeners go with the nodes.
 */
export function bindSortableHeaders(
	root: HTMLElement,
	keys: readonly string[],
	onActivate: (key: string) => void,
): void {
	if (keys.length === 0) return;
	root.querySelectorAll<HTMLElement>("th[data-sort]").forEach((header) => {
		const key = header.getAttribute("data-sort");
		if (!key || !keys.includes(key)) return;

		header.addEventListener("click", () => onActivate(key));
		header.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				onActivate(key);
			}
		});
	});
}

/** The sort affordance a header shows: the active arrow, or a hint that it can be sorted. */
export function sortIndicator(
	isActive: boolean,
	direction: SortDirection,
): string {
	if (!isActive) return '<span class="sort-hint">↕</span>';
	return direction === "asc"
		? '<span class="sort-active">↑</span>'
		: '<span class="sort-active">↓</span>';
}

/** Case- and whitespace-insensitive substring test for filter boxes. */
export function matchesQuery(value: string, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return true;
	return value.toLowerCase().includes(needle);
}
