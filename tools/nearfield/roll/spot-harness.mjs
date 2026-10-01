#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Roll-spot harness (Step Inside P2): drives the real /roll map in headless Chrome, builds the spot with
// the fast path (src/lib/nearfield/roll: /multiview DA3 posed → DEM-anchored per-photo lifts → voxel
// merge) and writes everything the offline leave-one-out comparison needs (tools/nearfield/roll/loo.py):
//   out/<roll>-vp<k>/all.ply                         fast-path fusion of every photo of the spot
//   out/<roll>-vp<k>/single_<id>.ply                 single-photo MoGe-2 lift of each photo
//   out/<roll>-vp<k>/fold_<h>/fast.ply               fast path without photo h
//   out/<roll>-vp<k>/fold_<h>/brush/                 COLMAP text model + RGBA images (alpha = near-field
//                                                    mask) + init.ply (= fast.ply) for Brush
//   out/<roll>-vp<k>/eval/<id>.{png,json}            held-out targets: photo, DEM range, people mask, camera
//   out/<roll>-vp<k>/meta.json                       per-view anchors, splits, merge stats, timings
// Plus screenshots tools/nearfield/shots/roll-*.png (Spot 3D toggle on the roll map).
// All positions are ENU of the roll frame shifted by the spot origin (mean eye of ALL the spot's photos).
//
//   node scripts/gpu/with-render-lock.mjs -- node tools/nearfield/roll/spot-harness.mjs [--roll region-0]
//        [--photo IMG_7063] [--no-folds] [--shots-only]
// Needs the private vite (:3110) and the near-field service (:8767).
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const URL0 = process.env.APP_URL ?? "http://localhost:3110";
const HERE = import.meta.dirname;
const SHOTS = resolve(HERE, "../shots");
const argv = process.argv.slice(2);
const arg = (k, d) => {
	const i = argv.indexOf(k);
	return i >= 0 ? argv[i + 1] : d;
};
const ROLL = arg("--roll", "region-0");
const PHOTO = arg("--photo", "IMG_7063");
const FOLDS = !argv.includes("--no-folds");
const SHOTS_ONLY = argv.includes("--shots-only");
/** Fast-path depth variants per fold: "multiview" (DA3 posed, the default path) and "moge2" (per photo). */
const VARIANTS = arg("--variants", "multiview,moge2,multiview-joint").split(
	",",
);
/** Variants that also get a Brush dataset (fold_<h>/brush[-<variant>]/). */
const BRUSH_VARIANTS = arg("--brush", "multiview,moge2,multiview-joint").split(
	",",
);
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
	args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
});
const t0 = Date.now();
const log = (...a) =>
	console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
try {
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => {
		const t = m.text();
		if (m.type() === "error") errors.push(t);
		if (t.includes("[spot]")) log(t);
	});
	await page.goto(`${URL0}/roll/${ROLL}?view=map&photo=${PHOTO}`);
	await page.waitForSelector('[data-testid="roll-map"][data-stage="ready"]', {
		timeout: 600_000,
	});
	log("map ready");

	// ---- the toggle, as a user would use it ----
	const map = page.locator('[data-testid="roll-map"]');
	await map.scrollIntoViewIfNeeded();
	await page.evaluate((id) => window.__roll.flyTo(id, 10), PHOTO);
	// imagery streams after the fly-in
	await page.waitForTimeout(8000);
	await map.screenshot({ path: `${SHOTS}/roll-spot-off.png` });
	await page.click('[data-testid="roll-spot3d"]');
	await page.waitForFunction(
		() =>
			/splats|unavailable|failed|no posed/.test(
				document.querySelector('[data-testid="roll-spot3d-note"]')
					?.textContent ?? "",
			),
		null,
		{ timeout: 900_000 },
	);
	const note = await page.textContent('[data-testid="roll-spot3d-note"]');
	log("toggle:", note);
	log(
		"spot:",
		JSON.stringify(
			await page.evaluate(() => {
				const s = window.__rollSpotLast;
				return s
					? {
							model: s.depthModel,
							sec: s.seconds,
							merge: s.merge,
							views: s.views.map((v) => ({
								id: v.id,
								scale: +v.anchor.scale.toFixed(3),
								q: +v.anchor.quality.toFixed(2),
								res: +v.anchor.residualLog.toFixed(3),
								n: v.anchor.n,
								win: v.anchorWindow,
								counts: v.split.counts,
								splats: v.splats,
							})),
						}
					: null;
			}),
		),
	);
	await page.waitForTimeout(2500);
	await map.screenshot({ path: `${SHOTS}/roll-spot-on.png` });
	await page.evaluate(() => window.__roll.setSettings({ drapeOpacity: 0 }));
	await page.waitForTimeout(1500);
	await map.screenshot({ path: `${SHOTS}/roll-spot-on-nodrape.png` });
	// step back and to the side of the viewpoint: parallax of the near field against the drape
	for (const [name, dx, dy, dz, turn] of [
		["side", 25, -20, 6, 35],
		["above", -10, -45, 35, 0],
	]) {
		await page.evaluate(
			({ dx, dy, dz, turn }) => {
				const e = window.__roll;
				const w = e.world;
				const p = e.debugPlaced().find((q) => q.id === e.photoId);
				const f = w.flight;
				if (f) f.held = true;
				const c = w.cam.position;
				c.set(p.eye[0] + dx, p.eye[1] + dy, p.eye[2] + dz);
				const yaw = ((p.pose.yaw + turn) * Math.PI) / 180;
				const tgt = [
					p.eye[0] + 60 * Math.sin(yaw),
					p.eye[1] + 60 * Math.cos(yaw),
					p.eye[2] - 25,
				];
				w.cam.lookAt(tgt[0], tgt[1], tgt[2]);
				e.setSettings({});
			},
			{ dx, dy, dz, turn },
		);
		await page.evaluate(() => window.__roll.setSettings({ drapeOpacity: 1 }));
		await page.waitForTimeout(2500);
		await map.screenshot({ path: `${SHOTS}/roll-spot-${name}.png` });
		await page.evaluate(() => window.__roll.setSettings({ drapeOpacity: 0 }));
		await page.waitForTimeout(1200);
		await map.screenshot({ path: `${SHOTS}/roll-spot-${name}-nodrape.png` });
	}
	await page.evaluate(() => {
		window.__roll.setSettings({ drapeOpacity: 1 });
		window.__roll.frameOverview();
	});
	if (SHOTS_ONLY) throw new Error("shots only: done");

	// ---- data for the offline comparison ----
	const spot = await page.evaluate(
		async ({ photo }) => {
			const m = await import("/src/lib/nearfield/roll/roll-spot.ts");
			const e = window.__roll;
			const vp = e.roll.photos.find((p) => p.meta.id === photo).viewpoint;
			const ids = m.spotPhotos(e.roll, vp).map((p) => p.meta.id);
			return {
				vp,
				ids,
				frame: { lat: e.frame.lat, lon: e.frame.lon, h: 0 },
				sources: Object.fromEntries(
					e.roll.photos
						.filter((p) => ids.includes(p.meta.id))
						.map((p) => [p.meta.id, p.poseSource]),
				),
			};
		},
		{ photo: PHOTO },
	);
	const OUT = resolve(HERE, `out/${ROLL}-vp${spot.vp}`);
	mkdirSync(`${OUT}/eval`, { recursive: true });
	log("spot", spot);
	const save = (rel, b64) => {
		const p = `${OUT}/${rel}`;
		mkdirSync(resolve(p, ".."), { recursive: true });
		writeFileSync(p, Buffer.from(b64, "base64"));
	};
	const saveJson = (rel, o) => {
		const p = `${OUT}/${rel}`;
		mkdirSync(resolve(p, ".."), { recursive: true });
		writeFileSync(p, JSON.stringify(o, null, 1));
	};

	// in-page helpers (installed once)
	await page.evaluate(async () => {
		const m = await import("/src/lib/nearfield/roll/roll-spot.ts");
		const spotM = await import("/src/lib/nearfield/roll/spot.ts");
		const vox = await import("/src/lib/nearfield/roll/voxel.ts");
		const col = await import("/src/lib/nearfield/roll/colmap-spot.ts");
		const ply = await import("/src/lib/export/splat.ts");
		const b64 = async (data) => {
			const blob = data instanceof Blob ? data : new Blob([data]);
			const url = await new Promise((r) => {
				const fr = new FileReader();
				fr.onload = () => r(fr.result);
				fr.readAsDataURL(blob);
			});
			return url.slice(url.indexOf(",") + 1);
		};
		const shift = (c, o) => {
			const p = c.positions.slice();
			for (let i = 0; i < c.count; i++)
				for (let a = 0; a < 3; a++) p[3 * i + a] -= o[a];
			return { ...c, positions: p };
		};
		const png = async (w, h, rgba) => {
			const c = new OffscreenCanvas(w, h);
			c.getContext("2d").putImageData(
				new ImageData(new Uint8ClampedArray(rgba), w, h),
				0,
				0,
			);
			return c.convertToBlob({ type: "image/png" });
		};
		const summary = (s) => ({
			ids: s.ids,
			count: s.cloud.count,
			depthModel: s.depthModel,
			seconds: s.seconds,
			origin: s.origin,
			merge: s.merge,
			views: s.views.map((v) => ({
				id: v.id,
				anchor: v.anchor,
				anchorWindow: v.anchorWindow,
				counts: v.split.counts,
				splats: v.splats,
				skipped: v.skipped ?? null,
			})),
			joint: (s.joint ?? []).map((j) =>
				j
					? {
							scale: j.scale,
							n: j.n,
							inlierFrac: j.inlierFrac,
							rotErrDeg: j.rotErrDeg,
							eyeShiftM: j.eyeShiftM,
						}
					: null,
			),
		});
		window.__spotH = { m, spotM, vox, col, ply, b64, shift, png, summary };
	});

	const origin = await page.evaluate(async ({ ids }) => {
		const e = window.__roll;
		const cams = await Promise.all(ids.map((id) => e.rangeMapFor(id, 1, 1)));
		return window.__spotH.spotM.spotOrigin(cams);
	}, spot);
	log("origin", origin);

	/** Build a spot in the page; returns its summary and the shifted cloud as .ply (base64). */
	const build = (ids, depth) =>
		page.evaluate(
			async ({ ids, depth, origin }) => {
				const H = window.__spotH;
				const s = await H.m.buildRollSpot(window.__roll, ids, {
					depth,
					onStatus: (t) =>
						console.log(`[spot] ${ids.join("+")} ${depth}: ${t}`),
				});
				if (!s) return null;
				window.__spotH.last = s;
				const plyB = H.ply.encodeGaussianPly(H.shift(s.cloud, origin), [
					`roll spot ${ids.join(",")} depth ${s.depthModel}`,
				]);
				return { summary: H.summary(s), ply: await H.b64(plyB) };
			},
			{ ids, depth, origin },
		);

	const meta = {
		roll: ROLL,
		viewpoint: spot.vp,
		ids: spot.ids,
		poseSources: spot.sources,
		frame: spot.frame,
		origin,
		runs: {},
	};
	// all photos: fast path
	const all = await build(spot.ids, "multiview");
	if (all) {
		save("all.ply", all.ply);
		meta.runs.all = all.summary;
		log("all", all.summary.count, "splats");
	}
	// single-photo MoGe-2 lifts (the baseline) and their eval targets
	for (const id of spot.ids) {
		const one = await build([id], "moge2");
		if (one) {
			save(`single_${id}.ply`, one.ply);
			meta.runs[`single_${id}`] = one.summary;
		}
		const ev = await page.evaluate(
			async ({ id, origin, frame }) => {
				const H = window.__spotH;
				const e = window.__roll;
				const p = e.roll.photos.find((q) => q.meta.id === id);
				const aspect = p.meta.width / p.meta.height;
				const W = aspect >= 1 ? 512 : Math.round(512 * aspect);
				const Hh = aspect >= 1 ? Math.round(512 / aspect) : 512;
				const r = await e.rangeMapFor(id, W, Hh);
				const img = new Image();
				img.src = p.meta.src;
				await img.decode();
				const c = new OffscreenCanvas(W, Hh);
				const g = c.getContext("2d");
				g.drawImage(img, 0, 0, W, Hh);
				const photo = await c.convertToBlob({ type: "image/png" });
				const pm = e.peopleMaskOf(id);
				const cm = H.col.spotColmap(
					[{ id, pose: r.pose, eye: r.eye, width: W, height: Hh }],
					null,
					origin,
					frame,
				);
				const rng = new Float32Array(r.range.length);
				for (let i = 0; i < rng.length; i++)
					rng[i] = Number.isFinite(r.range[i]) ? r.range[i] : 0;
				return {
					photo: await H.b64(photo),
					range: await H.b64(rng.buffer),
					people: pm ? await H.b64(pm.data.buffer.slice(0)) : null,
					json: {
						id,
						width: W,
						height: Hh,
						pose: r.pose,
						eye: r.eye,
						cameras: cm["cameras.txt"],
						images: cm["images.txt"],
						people: pm ? { width: pm.width, height: pm.height } : null,
						poseSource: p.poseSource,
					},
				};
			},
			{ id, origin, frame: spot.frame },
		);
		save(`eval/${id}.png`, ev.photo);
		save(`eval/${id}.range.f32`, ev.range);
		if (ev.people) save(`eval/${id}.people.u8`, ev.people);
		saveJson(`eval/${id}.json`, ev.json);
		log("single + eval", id);
	}
	// leave-one-out folds
	if (FOLDS)
		for (const h of spot.ids)
			for (const variant of VARIANTS) {
				const rest = spot.ids.filter((x) => x !== h);
				if (!rest.length) continue;
				const f = await build(rest, variant);
				const tag = variant === "multiview" ? "fast" : `fast-${variant}`;
				if (!f) {
					log("fold", h, variant, "failed");
					continue;
				}
				save(`fold_${h}/${tag}.ply`, f.ply);
				meta.runs[`fold_${h}${variant === "multiview" ? "" : `_${variant}`}`] =
					f.summary;
				if (!BRUSH_VARIANTS.includes(variant)) {
					log("fold", h, variant, f.summary.count, "splats");
					continue;
				}
				// Brush dataset from the SAME build (window.__spotH.last)
				const ds = await page.evaluate(
					async ({ origin, frame }) => {
						const H = window.__spotH;
						const s = H.last;
						const files = {};
						const views = [];
						for (const [k, v] of s.inputs.entries()) {
							const res = s.views[k];
							const mask = H.spotM.nearFieldMask(
								res.split,
								undefined,
								v.peopleMask,
							);
							const { width: W, height: Hh, data } = v.photo;
							const rgba = new Uint8ClampedArray(data);
							for (let j = 0; j < Hh; j++)
								for (let i = 0; i < W; i++) {
									const mi =
										Math.min(
											mask.height - 1,
											Math.floor(((j + 0.5) / Hh) * mask.height),
										) *
											mask.width +
										Math.min(
											mask.width - 1,
											Math.floor(((i + 0.5) / W) * mask.width),
										);
									rgba[4 * (j * W + i) + 3] = mask.data[mi];
								}
							// opaque photo + a loss mask (masks/<stem>.png alpha): Brush then ignores the far field,
							// sky and people instead of training black splats there (premultiplied RGBA would)
							files[`images/${v.id}.png`] = await H.b64(
								await H.png(W, Hh, new Uint8ClampedArray(data)),
							);
							files[`masks/${v.id}.png`] = await H.b64(
								await H.png(W, Hh, rgba),
							);
							views.push({
								id: v.id,
								pose: v.pose,
								eye: v.eye,
								width: W,
								height: Hh,
							});
						}
						const cm = H.col.spotColmap(views, s.cloud, origin, frame);
						files["sparse/0/cameras.txt"] = btoa(cm["cameras.txt"]);
						files["sparse/0/images.txt"] = btoa(cm["images.txt"]);
						files["sparse/0/points3D.txt"] = btoa(cm["points3D.txt"]);
						if (cm.initPly) files["init.ply"] = await H.b64(cm.initPly);
						return files;
					},
					{ origin, frame: spot.frame },
				);
				for (const [k, v] of Object.entries(ds))
					save(
						`fold_${h}/brush${variant === "multiview" ? "" : `-${variant}`}/${k}`,
						v,
					);
				log("fold", h, variant, f.summary.count, "splats");
			}
	saveJson("meta.json", meta);
	log("errors:", errors.slice(0, 10));
} catch (e) {
	if (!String(e).includes("shots only")) throw e;
	log("shots only");
} finally {
	await browser.close();
}
