// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Diagnostics for harnesses (globalThis.__rigiTerrainStats): terrain draw calls issued so far.
export const terrainDrawStats = { draws: 0 };
(
	globalThis as { __rigiTerrainStats?: typeof terrainDrawStats }
).__rigiTerrainStats = terrainDrawStats;
