// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Exports the sample photos for the /baseline page:
 *   public/baseline/<name>.jpg   (display-oriented JPEG, max side 2048)
 *   public/baseline/index.json   ([{ name, file, meta }] — PhotoMeta from the original HEIC)
 *
 *   npx tsx scripts/export-baseline-samples.ts [IMG_7033 ...]
 */
import fs from "node:fs";
import path from "node:path";
import { readPhotoMeta } from "../src/lib/geo/photo-meta";
import { heicToJpeg, imagePixelSize, listPhotos, ROOT } from "./lib/node-io";

const OUT = path.join(ROOT, "public", "baseline");

async function main() {
	fs.mkdirSync(OUT, { recursive: true });
	const index = [];
	for (const { name, heic } of listPhotos(process.argv.slice(2))) {
		// Metadata from the HEIC: sips may drop the Apple MakerNote (gravity).
		const meta = await readPhotoMeta(
			fs.readFileSync(heic),
			imagePixelSize(heic),
		);
		fs.copyFileSync(heicToJpeg(heic, 2048), path.join(OUT, `${name}.jpg`));
		index.push({ name, file: `${name}.jpg`, meta });
		console.log(
			`${name}  gps ${meta.lat?.toFixed(4)},${meta.lon?.toFixed(4)}  heading ${meta.heading?.toFixed(1)}  gravity ${meta.gravity ? "yes" : "no"}`,
		);
	}
	fs.writeFileSync(
		path.join(OUT, "index.json"),
		`${JSON.stringify(index, null, 1)}\n`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
