// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Eye-height numbers for the gipfelbuch page /gipfelbuch/step-inside: the EXIF GPS altitude of each bundled demo photo against the
 * DEM ground under it (both already measured by scripts/gipfelbuch/build-data.ts, read back from public/demo/gipfelbuch/<id>.json),
 * and the eye the pipeline then uses: max(alt, ground + EYE_ABOVE_GROUND) (src/lib/geo/pipeline.ts loadScene).
 *   npx tsx scripts/gipfelbuch/data-step-inside.ts
 */
import fs from "node:fs";

const rows = Array.from({ length: 12 }, (_, i) => {
	const id = `demo-${String(i + 1).padStart(2, "0")}`;
	const d = JSON.parse(
		fs.readFileSync(`public/demo/gipfelbuch/${id}.json`, "utf8"),
	);
	return {
		id,
		gpsAlt: d.gps.alt,
		ground: d.gps.ground,
		eye: d.gps.eye,
		hAccuracy: d.gps.hAccuracy,
		accepted: d.solved.accepted,
	};
});
fs.mkdirSync("public/demo/gipfelbuch/step-inside", { recursive: true });
fs.writeFileSync(
	"public/demo/gipfelbuch/step-inside/eye.json",
	JSON.stringify({
		generated: "2026-10-01",
		script: "scripts/gipfelbuch/data-step-inside.ts",
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

// ---------------------------------------------------------------------------------------------------------------
// The baked landing-page scene (public/demo/step/scene.json, scripts/demo/bake-step.mjs): the per-pixel split the
// real controller produced for IMG_7086, written as a small RGBA overlay PNG plus the anchor curve, for the
// "what the split decided" figure. Class order is PixelClass (types.ts): 0 Sky, 1 Terrain, 2 Object, 3 Far.
import zlib from "node:zlib";

const scene = JSON.parse(
	fs.readFileSync("public/demo/step/scene.json", "utf8"),
);
const {
	width: SW,
	height: SH,
	counts,
} = scene.split as {
	width: number;
	height: number;
	counts: number[];
};
const cls = Buffer.from(scene.split.cls as string, "base64");
const STRIDE = 2; // 1024x768 -> 512x384, nearest
const OW = SW / STRIDE;
const OH = SH / STRIDE;
const COLORS: Record<number, [number, number, number, number]> = {
	0: [0, 0, 0, 0],
	1: [0, 0, 0, 0],
	2: [217, 209, 122, 170], // Object: the near-field group colour #d9d17a
	3: [230, 159, 0, 110], // Far: the provenance 'dem' orange
};
const raw = Buffer.alloc((OW * 4 + 1) * OH);
for (let y = 0; y < OH; y++) {
	raw[y * (OW * 4 + 1)] = 0;
	for (let x = 0; x < OW; x++) {
		const c = cls[y * STRIDE * SW + x * STRIDE];
		const [r, g, b, a] = COLORS[c] ?? [0, 0, 0, 0];
		const o = y * (OW * 4 + 1) + 1 + x * 4;
		raw[o] = r;
		raw[o + 1] = g;
		raw[o + 2] = b;
		raw[o + 3] = a;
	}
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc32 = (b: Buffer) => {
	let c = 0xffffffff;
	for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OW, 0);
ihdr.writeUInt32BE(OH, 4);
ihdr[8] = 8;
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	chunk("IHDR", ihdr),
	chunk("IDAT", zlib.deflateSync(raw)),
	chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync("public/demo/gipfelbuch/step-inside/split.png", png);
const total = counts.reduce((s, v) => s + v, 0);
fs.writeFileSync(
	"public/demo/gipfelbuch/step-inside/split.json",
	JSON.stringify({
		generated: "2026-10-01",
		script: "scripts/gipfelbuch/data-step-inside.ts",
		source: "public/demo/step/scene.json (scripts/demo/bake-step.mjs)",
		photoId: scene.photoId,
		photo: scene.photo.src,
		width: scene.photo.width,
		height: scene.photo.height,
		model: scene.model,
		classes: {
			sky: counts[0],
			terrain: counts[1],
			object: counts[2],
			far: counts[3],
			total,
		},
		anchor: {
			quality: scene.anchor.quality,
			residualLog: scene.anchor.residualLog,
			residualLogAll: scene.anchor.residualLogAll,
			inlierFrac: scene.anchor.inlierFrac,
			n: scene.anchor.n,
			curve: scene.anchor.curve, // natural-log model range -> natural-log DEM range
		},
		medianObjectRange: scene.medianObjectRange,
		confidenceRadius: scene.confidenceRadius,
		splats: scene.splats,
	}),
);
console.log("split overlay", OW, OH, png.length, "bytes", counts, total);
