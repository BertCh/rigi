// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CR-04: engine exports default N to the EGM2008 grid at the frame origin (47-55 m in the Alps).
import { resolveGeoidUndulation } from "./engine-export";

const rigi = { frame: { lat: 47.056, lon: 8.485, h: 0 } };
const n = resolveGeoidUndulation(rigi as never);
const failures: string[] = [];
if (!(n > 44 && n < 58)) failures.push(`default N ${n} outside 44..58 m`);
if (resolveGeoidUndulation(rigi as never, 0) !== 0)
	failures.push("explicit 0 must be honoured");
if (resolveGeoidUndulation(rigi as never, 12.5) !== 12.5)
	failures.push("explicit N must be honoured");
if (failures.length) {
	console.error(failures.join("\n"));
	process.exit(1);
}
console.log(`geoid-default ok (N=${n.toFixed(1)} m at Rigi)`);
