// Lab: Step Inside P3, DEM-conditioned generation (research flag only; reports/step-inside-design.md).
//   /lab/generate?photo=IMG_7131&nearfield=gen [&step=10] [&width=768] [&stride=2] [&mono=0] [&moves=right,left,fwd]
// Pipeline (src/lib/nearfield/generate): the photo's ground-truth pose (data/ground-truth.json via roll.resolvePose)
// → MoGe-2 depth → NearFieldScene (split objectMargin 0.5, nearRadius 150) → for each novel camera near the eye:
// render the true RGB-D cache (DEM + photo drape + near-field splats) → hole mask → LaMa fills ONLY the holes
// (service POST /inpaint) → lift the filled pixels (DEM depth, else MoGe aligned to the DEM render) into
// Gaussians with provenance `generated` → merge. Panels: cache, holes, filled, merged (Truth: generated =
// magenta), merged (colour). Needs the near-field service (tools/nearfield/run.sh). Dev only.
// Harness hook: window.__genLab { done, error, summary, panels } (tools/nearfield/generate/shots.mjs).
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { hfovFromAspect } from "#/lib/camera";
import { PhotoEngine } from "#/lib/engine";
import { exportableCloud } from "#/lib/export/splat";
import { nearField } from "#/lib/nearfield/client";
import { CacheRenderer } from "#/lib/nearfield/generate/cache-render";
import {
	type RgbdView,
	rayDir,
	viewIntrinsics,
} from "#/lib/nearfield/generate/holes";
import { depthWithFov } from "#/lib/nearfield/generate/inpaint-client";
import {
	GENERATE_FLAG,
	type GenerateResult,
	generateAlongTrajectory,
} from "#/lib/nearfield/generate/pipeline";
import { readoutHit } from "#/lib/nearfield/generate/readout";
import {
	makeTrajectory,
	type NovelCamera,
} from "#/lib/nearfield/generate/trajectory";
import { buildNearFieldScene, imageToRGBA } from "#/lib/nearfield/scene";
import {
	ANCHOR_MIN_QUALITY,
	type NearFieldScene,
	PixelClass,
	PROVENANCE_CODE,
} from "#/lib/nearfield/types";
import { getPhoto, loadRegion } from "#/lib/photos";
import type { FgMask } from "#/lib/renderer";
import { resolvePose } from "#/lib/roll/roll";

type Search = {
	photo?: string;
	nearfield?: string;
	step?: number;
	width?: number;
	stride?: number;
	mono?: number;
	moves?: string;
};

const num = (v: unknown) => {
	const n =
		typeof v === "string" || typeof v === "number" ? Number(v) : Number.NaN;
	return Number.isFinite(n) ? n : undefined;
};

export const Route = createFileRoute("/lab/generate")({
	ssr: false,
	validateSearch: (s: Record<string, unknown>): Search => ({
		photo: typeof s.photo === "string" ? s.photo : undefined,
		nearfield: typeof s.nearfield === "string" ? s.nearfield : undefined,
		step: num(s.step),
		width: num(s.width),
		stride: num(s.stride),
		mono: num(s.mono),
		moves: typeof s.moves === "string" ? s.moves : undefined,
	}),
	head: () => ({ meta: [{ title: "Lab · DEM-conditioned generation" }] }),
	component: LabGenerate,
});

type Panel = { name: string; label: string; url: string };
type Row = { title: string; lines: string[]; panels: Panel[] };
type Summary = Record<string, unknown>;
type GenLab = {
	done: boolean;
	error?: string;
	summary?: Summary;
	panels: Panel[];
};

// ---- panel drawing ----

function toUrl(
	w: number,
	h: number,
	fill: (d: Uint8ClampedArray) => void,
): string {
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	const ctx = c.getContext("2d") as CanvasRenderingContext2D;
	const id = ctx.createImageData(w, h);
	fill(id.data);
	ctx.putImageData(id, 0, 0);
	return c.toDataURL("image/png");
}

const checker = (i: number, j: number) => (((i >> 3) + (j >> 3)) & 1 ? 40 : 58);

/** RGB of a view; unobserved pixels as a dark checkerboard ("nothing known here"). */
function viewUrl(v: RgbdView, holesAsChecker = true): string {
	return toUrl(v.width, v.height, (d) => {
		for (let j = 0; j < v.height; j++)
			for (let i = 0; i < v.width; i++) {
				const k = j * v.width + i;
				if (v.observed[k] || !holesAsChecker) {
					d.set(v.rgba.subarray(4 * k, 4 * k + 3), 4 * k);
				} else {
					const c = checker(i, j);
					d.set([c, c, c + 6], 4 * k);
				}
				d[4 * k + 3] = 255;
			}
	});
}

/** Hole mask: white = hole on a DEM surface (true depth), cyan = hole without DEM (sky / unknown), black = observed. */
function holeUrl(v: RgbdView, hole: Uint8Array): string {
	return toUrl(v.width, v.height, (d) => {
		for (let k = 0; k < hole.length; k++) {
			if (!hole[k]) d.set([0, 0, 0], 4 * k);
			else if (v.range[k] > 0) d.set([255, 255, 255], 4 * k);
			else d.set([80, 200, 230], 4 * k);
			d[4 * k + 3] = 255;
		}
	});
}

function rgbaUrl(rgba: ArrayLike<number>, w: number, h: number): string {
	return toUrl(w, h, (d) => {
		for (let k = 0; k < w * h; k++) {
			d[4 * k] = rgba[4 * k];
			d[4 * k + 1] = rgba[4 * k + 1];
			d[4 * k + 2] = rgba[4 * k + 2];
			d[4 * k + 3] = 255;
		}
	});
}

/** The photo with the split overlaid: magenta = Object (splats), green = Terrain, blue = Far. */
function splitUrl(
	scene: NearFieldScene,
	photo: { width: number; height: number; data: ArrayLike<number> },
) {
	const { width: W, height: H, cls } = scene.split;
	return toUrl(photo.width, photo.height, (d) => {
		for (let y = 0; y < photo.height; y++)
			for (let x = 0; x < photo.width; x++) {
				const k = y * photo.width + x;
				const c =
					cls[
						Math.min(H - 1, Math.floor((y / photo.height) * H)) * W +
							Math.min(W - 1, Math.floor((x / photo.width) * W))
					];
				const tint =
					c === PixelClass.Object
						? [230, 40, 200]
						: c === PixelClass.Terrain
							? [40, 200, 90]
							: c === PixelClass.Far
								? [60, 110, 230]
								: null;
				for (let q = 0; q < 3; q++)
					d[4 * k + q] = tint
						? 0.55 * photo.data[4 * k + q] + 0.45 * tint[q]
						: photo.data[4 * k + q];
				d[4 * k + 3] = 255;
			}
	});
}

const pct = (x: number) => `${(100 * x).toFixed(1)} %`;

function LabGenerate() {
	const search = Route.useSearch();
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [status, setStatus] = useState("starting");
	const [rows, setRows] = useState<Row[]>([]);
	const [head, setHead] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const flagOn = search.nearfield === GENERATE_FLAG;

	useEffect(() => {
		if (!flagOn || !import.meta.env.DEV) return;
		const canvas = canvasRef.current;
		if (!canvas) return;
		const photoId = search.photo ?? "IMG_7131";
		const lab: GenLab = { done: false, panels: [] };
		(window as unknown as { __genLab?: GenLab }).__genLab = lab;
		let engine: PhotoEngine | null = null;
		let cache: CacheRenderer | null = null;
		let cancelled = false;
		const ctl = new AbortController();
		const fail = (msg: string) => {
			lab.error = msg;
			lab.done = true;
			setError(msg);
			setStatus("failed");
		};
		(async () => {
			const photo = getPhoto(photoId);
			if (!photo) return fail(`unknown photo ${photoId}`);
			if (!(await nearField.available(true)))
				return fail(
					"near-field service not running (tools/nearfield/run.sh, http://127.0.0.1:8767)",
				);
			const t0 = performance.now();
			setStatus("loading photo + terrain");
			engine = new PhotoEngine(canvas, photo);
			engine.resize(canvas.clientWidth || 480, canvas.clientHeight || 360);
			let fg: FgMask | null = null;
			const seg = import("#/lib/segment");
			await engine.init(
				loadRegion(photo.region).catch(() => null),
				(m) => !cancelled && setStatus(m),
				async (img) => {
					fg = await (await seg).segmentForeground(img).catch(() => null);
					return fg;
				},
			);
			if (cancelled) return;
			const eng = engine;
			// accepted poses only: the ground-truth pose; anything else is refused (design decision 3)
			const rp = resolvePose(photo, { ignoreStored: true });
			if (rp.source !== "ground-truth")
				return fail(
					`${photoId} has no ground-truth pose (source ${rp.source}); P3 runs on accepted poses only`,
				);
			if (rp.eyeAlt != null) {
				eng.eye.z = rp.eyeAlt;
				eng.eyeAlt = rp.eyeAlt;
			}
			eng.setPose(rp.pose);
			eng.renderNow();
			if (!(await eng.readback())) return fail("geometry readback failed");
			const img = eng.photoElement;
			const terrain = eng.terrain;
			if (!img || !terrain) return fail("engine not ready");
			setStatus("MoGe-2 depth (service)");
			const hfov = hfovFromAspect(rp.pose.vfov, eng.aspect);
			const blob = await (await fetch(photo.src)).blob();
			const depth = await depthWithFov(blob, hfov, { maxSide: 768 });
			if (!depth) return fail("/depth failed");
			const photoRGBA = imageToRGBA(img, 1024);
			if (!photoRGBA) return fail("cannot read the photo pixels");
			setStatus("near-field scene");
			const scene = buildNearFieldScene({
				photoId,
				depth,
				renderer: eng,
				photo: photoRGBA,
				peopleMask: fg,
				split: { objectMargin: 0.5, nearRadius: 150, minGapM: 3 },
			});
			// drape mask: the Object cells (dilated one cell) + people: those are splats, and behind them is a hole
			const { width: SW, height: SH, cls } = scene.split;
			const drop = new Uint8Array(SW * SH);
			for (let j = 0; j < SH; j++)
				for (let i = 0; i < SW; i++) {
					let o = false;
					for (let dj = -1; dj <= 1 && !o; dj++)
						for (let di = -1; di <= 1 && !o; di++) {
							const ii = i + di;
							const jj = j + dj;
							if (
								ii >= 0 &&
								jj >= 0 &&
								ii < SW &&
								jj < SH &&
								cls[jj * SW + ii] === PixelClass.Object
							)
								o = true;
						}
					const f = fg as FgMask | null;
					if (!o && f) {
						const fx = Math.min(
							f.width - 1,
							Math.floor(((i + 0.5) / SW) * f.width),
						);
						const fy = Math.min(
							f.height - 1,
							Math.floor(((j + 0.5) / SH) * f.height),
						);
						o = f.data[fy * f.width + fx] >= 128;
					}
					drop[j * SW + i] = o ? 1 : 0;
				}
			cache = new CacheRenderer({
				renderer: eng.renderer,
				terrain: terrain.group,
				photoImage: img,
				photoRGBA,
				photoPose: rp.pose,
				photoEye: eng.eye,
				aspect: eng.aspect,
				dropMask: { width: SW, height: SH, data: drop },
				splats: scene.splats,
			});
			const step = search.step ?? 10;
			const pivotDist = Math.min(
				150,
				Math.max(20, 2 * (scene.confidenceRadius - 10)),
			);
			const names = (search.moves ?? "right,left,fwd").split(",");
			const moves = names.map((n) =>
				n === "left"
					? { name: `left-${step}m`, side: -step }
					: n === "fwd"
						? { name: `fwd-${step}m`, forward: step }
						: n === "up"
							? { name: `up-${step}m`, up: step }
							: { name: `right-${step}m`, side: step },
			);
			const cams = makeTrajectory(rp.pose, eng.eye, {
				moves,
				radius: scene.confidenceRadius,
				pivotDist,
			});
			const W = search.width ?? 768;
			const H = Math.round(W / eng.aspect);
			// sanity row: the cache from the photo camera itself (should be almost fully observed)
			const photoCam: NovelCamera = {
				name: "photo-eye",
				pose: rp.pose,
				eye: [eng.eye.x, eng.eye.y, eng.eye.z],
				offset: [0, 0, 0],
			};
			const atEye = cache.renderView(photoCam, W, H);
			let obsEye = 0;
			for (const x of atEye.observed) obsEye += x;
			const nObj = scene.splats.count;
			const anchorOk = scene.anchor.quality >= ANCHOR_MIN_QUALITY;
			const headLines = [
				...(anchorOk
					? []
					: [
							`WARNING: anchor quality ${scene.anchor.quality.toFixed(2)} < ${ANCHOR_MIN_QUALITY}: the near-field scene is untrusted (Step Inside would hide it); P3 runs anyway for research and inherits its errors`,
						]),
				`${photoId} · GT pose yaw ${rp.pose.yaw.toFixed(2)}° pitch ${rp.pose.pitch.toFixed(2)}° vfov ${rp.pose.vfov.toFixed(1)}° · eye ${eng.eye.z.toFixed(1)} m`,
				`anchor scale ${scene.anchor.scale.toFixed(2)} · quality ${scene.anchor.quality.toFixed(2)} · residualLog ${scene.anchor.residualLog.toFixed(3)} · split Object ${pct(scene.split.counts[PixelClass.Object] / (SW * SH))} · ${nObj.toLocaleString()} observed splats`,
				`confidence radius ${scene.confidenceRadius.toFixed(1)} m (moves clamped to it) · pivot ${pivotDist.toFixed(0)} m · views ${W}×${H} · ${fg ? "people mask on" : "no people mask"}`,
				`photo-eye cache coverage ${pct(obsEye / (W * H))} (sanity: should be ~100 % minus near-object edges)`,
				...(scene.anchor.quality < ANCHOR_MIN_QUALITY
					? [
							`WARNING anchor quality ${scene.anchor.quality.toFixed(2)} < ${ANCHOR_MIN_QUALITY}: the app would hide Step Inside here; the split / observed splats are untrusted`,
						]
					: []),
			];
			setHead(headLines);
			const newRows: Row[] = [
				{
					title: "photo + split",
					lines: [],
					panels: [
						{
							name: "photo-split",
							label: "photo · split (magenta Object, green Terrain, blue Far)",
							url: splitUrl(scene, photoRGBA),
						},
						{
							name: "photo-eye-cache",
							label: "cache rendered from the photo eye",
							url: viewUrl(atEye),
						},
					],
				},
			];
			setRows([...newRows]);
			lab.panels = newRows.flatMap((r) => r.panels);
			const res: GenerateResult = await generateAlongTrajectory(
				cache,
				scene.splats,
				cams,
				{
					width: W,
					stride: search.stride ?? 2,
					mono: search.mono !== 0,
					signal: ctl.signal,
					onProgress: (m) => !cancelled && setStatus(m),
				},
			);
			if (cancelled) return;
			// export + readout audit on the final merged scene
			const ex = exportableCloud({ ...scene, splats: res.merged });
			let rays = 0;
			let genHits = 0;
			let skipped = 0;
			for (const v of res.views) {
				const K = viewIntrinsics(v.view);
				for (let j = 0; j < 24; j++)
					for (let i = 0; i < 32; i++) {
						const h = readoutHit(
							res.merged,
							v.camera.eye,
							rayDir(v.camera.pose, K, (i + 0.5) / 32, (j + 0.5) / 24),
						);
						rays++;
						if (h?.provenance === PROVENANCE_CODE.generated) genHits++;
						if (h) skipped += h.skippedGenerated;
					}
			}
			for (const v of res.views) {
				const s = v.stats;
				newRows.push({
					title: v.camera.name,
					lines: [
						`offset E ${v.camera.offset[0].toFixed(1)} N ${v.camera.offset[1].toFixed(1)} U ${v.camera.offset[2].toFixed(1)} m · holes ${pct(s.holeFrac)} (DEM-backed ${pct(s.demBacked)}, no DEM ${pct(s.noGeo)})`,
						`LaMa ${v.inpaintMeta ? `${v.inpaintMeta.procWidth}×${v.inpaintMeta.procHeight} on ${v.inpaintMeta.device}, ${v.inpaintMeta.inferSeconds}s infer, ${(v.ms.inpaint / 1000).toFixed(1)}s round trip` : "not needed"} · mono ${v.mono ? `${v.mono.mode} scale ${v.mono.scale.toFixed(2)} res ${v.mono.residualLog.toFixed(3)} n ${v.mono.n}` : "—"}`,
						`+${v.added.toLocaleString()} generated (DEM ${v.lift.demBacked}, mono ${v.lift.mono}, skipped ${v.lift.skipped}) · re-render covers ${pct(v.reproj.covered)} of the holes, mean |ΔRGB| ${v.reproj.meanAbsDiff.toFixed(1)}`,
					],
					panels: [
						{
							name: `${v.camera.name}-cache`,
							label: "novel view: RGB-D cache (checker = unknown)",
							url: viewUrl(v.view),
						},
						{
							name: `${v.camera.name}-holes`,
							label: "holes (white = DEM-backed, cyan = no DEM)",
							url: holeUrl(v.view, v.hole),
						},
						{
							name: `${v.camera.name}-filled`,
							label: "LaMa fill (holes only)",
							url: v.filled
								? rgbaUrl(v.filled, v.view.width, v.view.height)
								: viewUrl(v.view),
						},
						{
							name: `${v.camera.name}-merged-truth`,
							label: "merged splats · Truth (magenta = generated)",
							url: viewUrl(v.mergedTruth),
						},
						{
							name: `${v.camera.name}-merged`,
							label: "merged · colour",
							url: viewUrl(v.merged),
						},
					],
				});
			}
			const summary: Summary = {
				photoId,
				pose: rp.pose,
				eyeAlt: eng.eye.z,
				anchor: scene.anchor,
				confidenceRadius: scene.confidenceRadius,
				observedSplats: res.observedCount,
				generatedSplats: res.generatedCount,
				photoEyeCoverage: obsEye / (W * H),
				anchorOk,
				views: res.views.map((v) => ({
					name: v.camera.name,
					offset: v.camera.offset,
					holes: v.stats,
					added: v.added,
					lift: v.lift,
					mono: v.mono,
					reproj: v.reproj,
					inpaint: v.inpaintMeta && {
						device: v.inpaintMeta.device,
						inferSeconds: v.inpaintMeta.inferSeconds,
						proc: [v.inpaintMeta.procWidth, v.inpaintMeta.procHeight],
					},
					ms: v.ms,
				})),
				exportAudit: {
					...ex.stats,
					generatedInExport: Array.from(ex.cloud.provenance).filter(
						(p) => p === PROVENANCE_CODE.generated,
					).length,
				},
				readoutAudit: {
					rays,
					generatedHits: genHits,
					generatedSkipped: skipped,
				},
				seconds: (performance.now() - t0) / 1000,
			};
			setHead([
				...headLines,
				`EXPORT AUDIT: ${ex.stats.kept} kept, ${ex.stats.droppedGenerated} generated left out, ${summary.exportAudit && (summary.exportAudit as { generatedInExport: number }).generatedInExport} generated in the export · READOUT AUDIT: ${rays} rays, ${genHits} generated hits, ${skipped} generated skipped`,
				`total ${(summary.seconds as number).toFixed(1)} s`,
			]);
			setRows([...newRows]);
			lab.summary = summary;
			lab.panels = newRows.flatMap((r) => r.panels);
			lab.done = true;
			setStatus("done");
		})().catch((e) => fail(String((e as Error)?.message ?? e)));
		return () => {
			cancelled = true;
			ctl.abort();
			cache?.dispose();
			engine?.dispose();
		};
	}, [
		flagOn,
		search.photo,
		search.step,
		search.width,
		search.stride,
		search.mono,
		search.moves,
	]);

	if (!import.meta.env.DEV)
		return <p style={{ padding: 16 }}>This lab is dev-only.</p>;
	if (!flagOn)
		return (
			<p style={{ padding: 16, font: "14px system-ui" }}>
				DEM-conditioned generation is a research flag: add{" "}
				<code>?nearfield=gen</code> (and optionally
				<code> &amp;photo=IMG_7131</code>).
			</p>
		);
	return (
		<div
			style={{
				minHeight: "100vh",
				background: "#111316",
				color: "#ddd",
				font: "12px system-ui",
				padding: 12,
			}}
		>
			<div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
				<canvas
					ref={canvasRef}
					style={{ width: 240, height: 180, background: "#000", flex: "none" }}
				/>
				<div>
					<div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
						DEM-conditioned generation · research flag · generated content is
						never measurable
					</div>
					<div data-testid="gen-status">status: {status}</div>
					{error && <div style={{ color: "#f77" }}>error: {error}</div>}
					{head.map((l) => (
						<div key={l}>{l}</div>
					))}
				</div>
			</div>
			{rows.map((r) => (
				<div key={r.title} style={{ marginTop: 14 }}>
					<div style={{ fontWeight: 600, fontSize: 13 }}>{r.title}</div>
					{r.lines.map((l) => (
						<div key={l} style={{ color: "#aaa" }}>
							{l}
						</div>
					))}
					<div
						style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}
					>
						{r.panels.map((p) => (
							<figure key={p.name} style={{ margin: 0, width: 300 }}>
								<img
									src={p.url}
									alt={p.label}
									style={{ width: 300, display: "block" }}
								/>
								<figcaption style={{ color: "#999" }}>{p.label}</figcaption>
							</figure>
						))}
					</div>
				</div>
			))}
		</div>
	);
}
