// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/** `next` if it differs from `prev` by any element (===), else `prev` itself, so memos keyed on it do not re-run. */
export function reuseIfSame<T>(prev: readonly T[] | null, next: T[]): T[] {
	if (
		prev &&
		prev.length === next.length &&
		prev.every((x, i) => x === next[i])
	)
		return prev as T[];
	return next;
}
