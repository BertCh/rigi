// Turn an exported upload roll (/dev/export-roll → rigi-roll-<id>.json) into the bundled sample trip:
// public/demo/manifest.json + photos/ + thumbs/. The whole roll is kept except photos with no pose at
// all (source "prior"; --keep-prior keeps them too); --exclude a,b drops photos by original id.
//   node scripts/demo/unpack.mjs ~/Downloads/rigi-roll-local-roll-c675ff057c.json --name "…" --place "…"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (k, d) => {
	const i = args.indexOf(`--${k}`);
	return i >= 0 ? args[i + 1] : d;
};
const bundle = JSON.parse(readFileSync(args[0], "utf8"));
const exclude = new Set((opt("exclude", "") || "").split(",").filter(Boolean));
const keepPrior = args.includes("--keep-prior");
const out = "public/demo";

const kept = bundle.photos
	.filter((p) => !exclude.has(p.meta.id))
	.filter((p) => keepPrior || p.poseSource !== "prior")
	.sort((a, b) => a.meta.takenAt.localeCompare(b.meta.takenAt));
const dropped = bundle.photos.filter((p) => !kept.includes(p));

rmSync(join(out, "photos"), { recursive: true, force: true });
rmSync(join(out, "thumbs"), { recursive: true, force: true });
mkdirSync(join(out, "photos"), { recursive: true });
mkdirSync(join(out, "thumbs"), { recursive: true });

const REGION = "demo-region";
const idOf = new Map(
	kept.map((p, i) => [p.meta.id, `demo-${String(i + 1).padStart(2, "0")}`]),
);
const photos = [];
const poses = {};
for (const p of kept) {
	const id = idOf.get(p.meta.id);
	writeFileSync(join(out, "photos", `${id}.jpg`), Buffer.from(p.jpg, "base64"));
	if (p.thumb)
		writeFileSync(
			join(out, "thumbs", `${id}.jpg`),
			Buffer.from(p.thumb, "base64"),
		);
	// the upload extras stay (they mark which sensors were missing); file names and sizes go
	const {
		fileName: _n,
		fileBytes: _b,
		addedAt: _a,
		...local
	} = p.meta.local ?? {};
	photos.push({
		...p.meta,
		id,
		src: `/demo/photos/${id}.jpg`,
		thumb: p.thumb ? `/demo/thumbs/${id}.jpg` : `/demo/photos/${id}.jpg`,
		region: REGION,
		local,
	});
	if (p.poseSource !== "prior")
		poses[id] = {
			pose: p.pose,
			source: p.poseSource,
			confidence: p.confidence,
		};
}

const src = Object.values(bundle.regions).filter(Boolean);
const region = {
	id: REGION,
	center: src[0]?.center ?? [photos[0].lat, photos[0].lon],
	photos: photos.map((p) => p.id),
	peaks: dedupe(
		src.flatMap((r) => r.peaks ?? []),
		(k) => `${k.name}|${k.lat}|${k.lon}`,
	),
	trails: src.flatMap((r) => r.trails ?? []),
	waterNames: [...new Set(src.flatMap((r) => r.waterNames ?? []))],
};
function dedupe(xs, key) {
	const m = new Map();
	for (const x of xs) m.set(key(x), x);
	return [...m.values()];
}

const manifest = {
	name: opt("name", bundle.roll.name),
	place: opt("place", ""),
	photos,
	poses,
	region,
};
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
console.log(
	`kept ${photos.length}, dropped ${dropped.length}: ${dropped.map((p) => `${p.meta.id} (${p.poseSource})`).join(", ")}`,
);
for (const p of kept)
	console.log(
		idOf.get(p.meta.id),
		p.meta.id,
		p.poseSource,
		p.confidence?.toFixed?.(2) ?? "",
		`${p.meta.width}x${p.meta.height}`,
		p.meta.takenAt,
		`hdg ${Math.round(p.meta.heading ?? -1)} yaw ${Math.round(p.pose.yaw)}`,
		`f35 ${p.meta.f35}`,
	);
console.log(
	`region: ${region.peaks.length} peaks, ${region.trails.length} trails`,
);
