// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Eye-height numbers for the atlas page /atlas/step-inside: the EXIF GPS altitude of each bundled demo photo against the
 * DEM ground under it (both already measured by scripts/atlas/build-data.ts, read back from public/demo/atlas/<id>.json),
 * and the eye the pipeline then uses: max(alt, ground + EYE_ABOVE_GROUND) (src/lib/geo/pipeline.ts loadScene).
 *   npx tsx scripts/atlas/data-step-inside.ts
 */
import fs from "node:fs";

const rows = Array.from({ length: 12 }, (_, i) => {
	const id = `demo-${String(i + 1).padStart(2, "0")}`;
	const d = JSON.parse(fs.readFileSync(`public/demo/atlas/${id}.json`, "utf8"));
	return {
		id,
		gpsAlt: d.gps.alt,
		ground: d.gps.ground,
		eye: d.gps.eye,
		hAccuracy: d.gps.hAccuracy,
		accepted: d.solved.accepted,
	};
});
fs.mkdirSync("public/demo/atlas/step-inside", { recursive: true });
fs.writeFileSync(
	"public/demo/atlas/step-inside/eye.json",
	JSON.stringify({
		generated: "2026-10-01",
		script: "scripts/atlas/data-step-inside.ts",
		dem: "terrarium",
		rows,
	}),
);
for (const r of rows)
	console.log(
		r.id,
		r.gpsAlt,
		r.ground,
		(r.gpsAlt - r.ground).toFixed(1),
		r.eye,
	);
