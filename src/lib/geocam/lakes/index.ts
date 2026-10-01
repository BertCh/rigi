// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Lakes (GEO GA0): compact OSM lake geometry, levels and the eye floor (the floor's MAP prior factor is
// map/factors.ts lakeFloorFactor). The GA4 waterline / shore factors were removed on 2026-09-30.
export * from "./compact";
export * from "./fetch";
export * from "./floor";
export * from "./levels";
