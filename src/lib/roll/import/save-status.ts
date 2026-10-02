// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Mark every item whose CURRENT status is "saving" as a save error. Apply it through a functional
 * state updater: a snapshot taken when the save started no longer shows which items are still saving.
 * Items in any other status are returned unchanged (same reference).
 */
export const markSavingFailed = <T extends { status: string; error?: string }>(
	items: readonly T[],
	message: string,
): T[] =>
	items.map((item) =>
		item.status === "saving"
			? { ...item, status: "save-error", error: message }
			: item,
	);
