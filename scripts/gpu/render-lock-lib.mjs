// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * True when a lock owner is stale and its lock dir may be removed.
 * A dead pid is stale. A live pid is stale only when both the recorded and the current start
 * time are known and differ (a recycled pid); an unknown current start time (`ps` failed) never
 * reclaims a live owner's lock.
 */
export const isStaleOwner = ({ pid, alive, recorded, current }) => {
	if (!pid) return false;
	if (!alive) return true;
	return Boolean(recorded && current && current !== recorded);
};
