// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type Camera,
	type CameraParams,
	cameraFromAngles,
	cameraFromMeta,
	cameraParams,
	directionENU,
	displaySize,
	focalPx,
	project,
	resizeCamera,
} from "#/lib/geo/camera";
import { solveFromControlPoints } from "#/lib/geo/control-points";
import { layoutPeakLabels } from "#/lib/geo/peaks";
import {
	type ExifPhotoMeta,
	readPhotoMeta,
	withDisplayPixels,
} from "#/lib/geo/photo-meta";
import { wrap180, wrap360 } from "#/lib/geodesy";
import { type Layers, Overlay } from "./Overlay";
import {
	bucketColor,
	nearestSkylinePoint,
	placeLabels,
	RIDGE_BUCKETS,
} from "./projection";
import type { BaselinePeakLabel, ControlPoint, SampleEntry } from "./types";
import { Button, Notice, Section, Slider, Toggle } from "./ui";
import { usePipeline } from "./usePipeline";

const DEG = 180 / Math.PI;
const SKYLINE_WIDTH = 800;
const MAX_LABELS = 30;

interface Photo {
	id: string;
	name: string;
	src: string;
	meta: ExifPhotoMeta | null;
	metaError?: string;
	heic: boolean;
}

interface Location {
	lat: number;
	lon: number;
	altitude?: number;
	manual: boolean;
}

interface Pending {
	key: string | null;
	label: string;
	azimuth: number;
	elevation: number;
}

const hfov = (p: CameraParams) => 2 * Math.atan(p.width / 2 / p.f) * DEG;

/** Prior camera at the working-image size; falls back to level + heading. */
/** Pixel distance between a control point and where the camera projects it. */
function pointErrPx(cam: Camera, p: ControlPoint) {
	const q = project(cam, directionENU(p.azimuth, p.elevation));
	return q ? Math.hypot(q[0] - p.x, q[1] - p.y) : 1e4;
}

function priorCamera(meta: ExifPhotoMeta | null, w: number, h: number) {
	const missing: string[] = [];
	if (meta?.gravity && meta.heading !== undefined && meta.focal35) {
		const full = cameraFromMeta(meta);
		const ds = displaySize(meta);
		const cam = resizeCamera(full, w);
		if (Math.abs(ds.width / ds.height - w / h) > 0.01)
			return {
				cam: { ...cam, height: h, cy: h / 2 },
				missing: ["matching aspect ratio (image was cropped?)"],
			};
		return { cam, missing };
	}
	if (!meta?.gravity) missing.push("gravity (pitch/roll)");
	if (meta?.heading === undefined) missing.push("compass heading");
	if (!meta?.focal35) missing.push("focal length");
	const cam = cameraFromAngles({
		width: w,
		height: h,
		f: focalPx(meta?.focal35 ?? 26, w, h),
		yaw: meta?.heading ?? 0,
		pitch: 0,
		roll: 0,
	});
	return { cam, missing };
}

export function BaselinePage({
	sample,
	onSampleChange,
}: {
	sample?: string;
	onSampleChange: (name: string | undefined) => void;
}) {
	const pipeline = usePipeline();
	const { state } = pipeline;

	const [samples, setSamples] = useState<SampleEntry[]>([]);
	const [samplesError, setSamplesError] = useState<string | null>(null);
	const [photo, setPhoto] = useState<Photo | null>(null);
	const [img, setImg] = useState<HTMLImageElement | null>(null);
	const [imgError, setImgError] = useState<string | null>(null);
	const [manual, setManual] = useState({ lat: "", lon: "" });
	const [manualLoc, setManualLoc] = useState<Location | null>(null);
	const [prior, setPrior] = useState<{ cam: Camera; missing: string[] } | null>(
		null,
	);
	const [params, setParams] = useState<CameraParams | null>(null);
	const [layers, setLayers] = useState<Layers>({
		ridges: true,
		peaks: true,
		detected: true,
	});
	const [tapMode, setTapMode] = useState(false);
	const [pending, setPending] = useState<Pending | null>(null);
	const [points, setPoints] = useState<ControlPoint[]>([]);
	const [cpRms, setCpRms] = useState<number | null>(null);
	const [tapHint, setTapHint] = useState<string | null>(null);
	const [dragOver, setDragOver] = useState(false);
	const [box, setBox] = useState<{ w: number; h: number } | null>(null);
	const nextPointId = useRef(1);

	// --- data sources --------------------------------------------------------
	useEffect(() => {
		fetch("/baseline/index.json")
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.json() as Promise<SampleEntry[]>;
			})
			.then(setSamples)
			.catch((e) =>
				setSamplesError(
					`Could not load samples (${e.message}). Run: npx tsx scripts/export-baseline-samples.ts`,
				),
			);
	}, []);

	const { clearPhoto, clearRun, run, detectSkyline, align } = pipeline;
	const objectUrl = useRef<string | null>(null);

	/** Switches photo and resets all per-photo state in the same batch. */
	const showPhoto = useCallback(
		(next: Photo | null) => {
			if (objectUrl.current && objectUrl.current !== next?.src) {
				URL.revokeObjectURL(objectUrl.current);
				objectUrl.current = null;
			}
			if (next?.id.startsWith("file:")) objectUrl.current = next.src;
			setPhoto(next);
			setImg(null);
			setImgError(null);
			setBox(null);
			setPrior(null);
			setParams(null);
			setPoints([]);
			setPending(null);
			setCpRms(null);
			setTapHint(null);
			setManualLoc(null);
			clearPhoto();
			const m = next?.meta;
			setManual({
				lat: m?.lat !== undefined ? m.lat.toFixed(5) : "",
				lon: m?.lon !== undefined ? m.lon.toFixed(5) : "",
			});
		},
		[clearPhoto],
	);

	const selectedSample = sample ?? samples[0]?.name;
	useEffect(() => {
		if (!selectedSample || photo?.id.startsWith("file:")) return;
		const s = samples.find((x) => x.name === selectedSample);
		if (!s || photo?.id === `sample:${s.name}`) return;
		showPhoto({
			id: `sample:${s.name}`,
			name: s.name,
			src: `/baseline/${s.file}`,
			meta: s.meta,
			heic: false,
		});
	}, [selectedSample, samples, photo?.id, showPhoto]);

	const openFile = useCallback(
		async (file: File) => {
			const heic = /\.hei[cf]$/i.test(file.name) || /hei[cf]/i.test(file.type);
			let meta: ExifPhotoMeta | null = null;
			let metaError: string | undefined;
			try {
				meta = await readPhotoMeta(file);
			} catch (e) {
				metaError = e instanceof Error ? e.message : String(e);
			}
			showPhoto({
				id: `file:${file.name}:${file.size}:${file.lastModified}:${Date.now()}`,
				name: file.name,
				src: URL.createObjectURL(file),
				meta,
				metaError,
				heic,
			});
		},
		[showPhoto],
	);

	// --- location + pipeline -------------------------------------------------
	const location: Location | null = useMemo(() => {
		if (manualLoc) return manualLoc;
		const m = photo?.meta;
		if (m?.lat !== undefined && m.lon !== undefined)
			return { lat: m.lat, lon: m.lon, altitude: m.altitude, manual: false };
		return null;
	}, [manualLoc, photo?.meta]);

	useEffect(() => {
		if (location) run(location.lat, location.lon, location.altitude);
		else clearRun();
	}, [location, run, clearRun]);

	const applyManual = () => {
		const lat = Number.parseFloat(manual.lat);
		const lon = Number.parseFloat(manual.lon);
		if (!(Math.abs(lat) <= 85 && Math.abs(lon) <= 180)) return;
		setManualLoc({ lat, lon, manual: true });
	};

	// --- image → prior camera + skyline detection ----------------------------
	const onImgLoad = (el: HTMLImageElement) => {
		const w = el.naturalWidth;
		const h = el.naturalHeight;
		// An opened file shows the original at full resolution: its natural size is the real
		// pixel size (a Photos crop keeps the sensor size in EXIF). Samples are resized JPEGs.
		const meta =
			photo?.meta && photo.id.startsWith("file:")
				? withDisplayPixels(photo.meta, w, h)
				: (photo?.meta ?? null);
		const p = priorCamera(meta, w, h);
		setPrior(p);
		setParams(cameraParams(p.cam));
		setImg(el);
	};

	useEffect(() => {
		if (!img) return;
		const w = Math.min(SKYLINE_WIDTH, img.naturalWidth);
		const h = Math.round((img.naturalHeight * w) / img.naturalWidth);
		const c = document.createElement("canvas");
		c.width = w;
		c.height = h;
		const ctx = c.getContext("2d", { willReadFrequently: true });
		if (!ctx) return;
		ctx.drawImage(img, 0, 0, w, h);
		detectSkyline(ctx.getImageData(0, 0, w, h));
	}, [img, detectSkyline]);

	const cam = useMemo(
		() => (params ? cameraFromAngles(params) : null),
		[params],
	);

	const applyAlign = useCallback(() => {
		if (state.align && img)
			setParams(
				cameraParams(resizeCamera(state.align.camera, img.naturalWidth)),
			);
	}, [state.align, img]);
	// solve.ts result: apply only when accepted; otherwise keep the pose.
	useEffect(() => {
		if (state.align?.accepted) applyAlign();
	}, [state.align, applyAlign]);

	// --- display sizing ------------------------------------------------------
	const stage = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = stage.current;
		if (!el || !img) return;
		const fit = () => {
			const cs = getComputedStyle(el);
			const availW =
				el.clientWidth -
				Number.parseFloat(cs.paddingLeft) -
				Number.parseFloat(cs.paddingRight);
			const lg = window.matchMedia("(min-width: 1024px)").matches;
			const availH = Math.max(
				240,
				lg ? window.innerHeight - 96 : window.innerHeight * 0.7,
			);
			const s = Math.min(availW / img.naturalWidth, availH / img.naturalHeight);
			setBox({ w: img.naturalWidth * s, h: img.naturalHeight * s });
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		window.addEventListener("resize", fit);
		return () => {
			ro.disconnect();
			window.removeEventListener("resize", fit);
		};
	}, [img]);
	const k = cam && box ? cam.width / box.w : 1;

	// --- peak labels ---------------------------------------------------------
	const labels: BaselinePeakLabel[] = useMemo(() => {
		if (!cam || !state.peaks) return [];
		// peaks.ts ranks and thins the labels; we stack them to avoid overlaps.
		const cands = layoutPeakLabels(state.peaks.views, cam, {
			maxLabels: MAX_LABELS,
		}).map(({ peak, x, y, azimuth, elevation }) => ({
			key: `${peak.name ?? ""}@${azimuth.toFixed(3)}`,
			name: peak.name ?? "",
			ele: peak.ele,
			x,
			y,
			lx: x,
			ly: y,
			azimuth,
			elevation,
		}));
		return placeLabels(cands, k, cam.width, MAX_LABELS);
	}, [cam, state.peaks, k]);

	// --- camera interactions -------------------------------------------------
	const dragStart = useRef<CameraParams | null>(null);
	const onDrag = (dx: number, dy: number, phase: "start" | "move" | "end") => {
		if (!params) return;
		if (phase === "start") {
			dragStart.current = params;
			return;
		}
		const s = dragStart.current;
		if (!s) return;
		setParams({
			...s,
			yaw: s.yaw - Math.atan(dx / s.f) * DEG,
			pitch: s.pitch + Math.atan(dy / s.f) * DEG,
		});
		if (phase === "end") dragStart.current = null;
	};

	const solveWith = (pts: ControlPoint[]) => {
		if (!cam || pts.length === 0) {
			setCpRms(null);
			return;
		}
		const r = solveFromControlPoints(cam, pts);
		setParams(cameraParams(r.camera));
		setCpRms(r.rmsPx);
	};

	const onTap = (x: number, y: number) => {
		if (!cam) return;
		if (pending) {
			const pt: ControlPoint = {
				id: nextPointId.current++,
				label: pending.label,
				x,
				y,
				azimuth: pending.azimuth,
				elevation: pending.elevation,
			};
			const next = [...points, pt];
			setPoints(next);
			setPending(null);
			setTapHint(null);
			solveWith(next);
			return;
		}
		const hit = state.horizon
			? nearestSkylinePoint(cam, state.horizon.horizon, x, y, 25 * k)
			: null;
		if (hit) {
			setPending({
				key: null,
				label: `Skyline @ ${hit.azimuth.toFixed(1)}°`,
				azimuth: hit.azimuth,
				elevation: hit.elevation,
			});
			setTapHint(null);
		} else {
			setTapHint(
				"Tap a peak label or a point on the magenta skyline first, then tap where it really is.",
			);
		}
	};

	const removePoint = (id: number) => {
		const next = points.filter((p) => p.id !== id);
		setPoints(next);
		solveWith(next);
	};

	const resetToPrior = () => {
		if (prior) setParams(cameraParams(prior.cam));
	};

	const canAlign = !!state.horizon && !!state.sky && !!cam && !state.aligning;

	// --- render --------------------------------------------------------------
	const meta = photo?.meta;
	const noGps = !!photo && (meta?.lat === undefined || meta?.lon === undefined);
	const progress = state.progress;

	return (
		<div
			data-theme="dark"
			className="min-h-screen bg-neutral-100 text-neutral-900"
		>
			<header className="flex items-center justify-between gap-4 border-b border-neutral-200 bg-white px-4 py-2">
				<div className="flex items-baseline gap-3">
					<h1 className="text-base font-semibold">Georeferencing baseline</h1>
					<span className="hidden text-sm text-neutral-500 sm:inline">
						EXIF prior + DEM horizon + manual / tap alignment
					</span>
				</div>
				<Link
					to="/"
					className="text-sm text-neutral-600 hover:text-neutral-900"
				>
					← Home
				</Link>
			</header>

			<div className="grid lg:grid-cols-[minmax(0,1fr)_360px]">
				<main
					ref={stage}
					className={`relative min-w-0 p-3 ${dragOver ? "outline-2 -outline-offset-8 outline-dashed outline-neutral-400" : ""}`}
					onDragOver={(e) => {
						e.preventDefault();
						setDragOver(true);
					}}
					onDragLeave={() => setDragOver(false)}
					onDrop={(e) => {
						e.preventDefault();
						setDragOver(false);
						const f = e.dataTransfer.files?.[0];
						if (f) openFile(f);
					}}
				>
					{!photo && (
						<div className="flex h-[50vh] items-center justify-center rounded-lg border-2 border-dashed border-neutral-300 text-neutral-500">
							{samplesError ?? "Pick a sample or drop a photo here"}
						</div>
					)}
					{photo && (
						<div
							className="relative mx-auto overflow-hidden rounded bg-neutral-800"
							style={
								box
									? { width: box.w, height: box.h }
									: { width: "100%", minHeight: 240 }
							}
						>
							<img
								key={photo.id}
								src={photo.src}
								alt={photo.name}
								draggable={false}
								className={`block h-full w-full select-none ${img ? "" : "invisible"}`}
								onLoad={(e) => onImgLoad(e.currentTarget)}
								onError={() =>
									setImgError(
										photo.heic
											? "This browser can't display HEIC images. Open the photo in Safari, or export it as JPEG (keep location metadata) and upload that."
											: "Could not load this image.",
									)
								}
							/>
							{cam && img && (
								<Overlay
									cam={cam}
									horizon={state.horizon?.horizon ?? null}
									labels={labels}
									sky={state.sky}
									layers={layers}
									points={points}
									pendingKey={pending?.key ?? null}
									tapMode={tapMode}
									k={k}
									onDrag={onDrag}
									onTap={onTap}
									onLabel={(l) =>
										setPending({
											key: l.key,
											label: l.name,
											azimuth: l.azimuth,
											elevation: l.elevation,
										})
									}
								/>
							)}
							{!img && !imgError && (
								<div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-300">
									Loading photo…
								</div>
							)}
							{imgError && (
								<div className="absolute inset-0 flex items-center justify-center p-6">
									<Notice tone="error">{imgError}</Notice>
								</div>
							)}
							{progress && (
								<div className="pointer-events-none absolute top-2 left-2 rounded bg-black/60 px-2 py-1 text-xs text-white">
									{progress.message}
								</div>
							)}
							{tapMode && (
								<div className="pointer-events-none absolute right-2 bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-center text-xs text-white">
									{pending
										? `Now tap where “${pending.label}” really is`
										: (tapHint ?? "Tap a peak label or a skyline point")}
								</div>
							)}
						</div>
					)}
				</main>

				<aside className="border-neutral-200 bg-white lg:h-[calc(100vh-41px)] lg:overflow-y-auto lg:border-l">
					<Section title="Photo">
						<div className="flex flex-wrap items-center gap-2">
							<select
								className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm"
								value={photo?.id.startsWith("sample:") ? photo.name : ""}
								onChange={(e) => {
									if (photo?.id.startsWith("file:")) showPhoto(null);
									onSampleChange(e.target.value || undefined);
								}}
							>
								<option value="">
									{samples.length ? "Choose a sample…" : "No samples"}
								</option>
								{samples.map((s) => (
									<option key={s.name} value={s.name}>
										{s.name}
									</option>
								))}
							</select>
							<label className="cursor-pointer rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-neutral-100">
								Upload…
								<input
									type="file"
									accept="image/jpeg,image/heic,image/heif,image/png,image/webp,image/avif,.jpg,.jpeg,.heic,.heif,.png,.webp,.avif"
									className="hidden"
									onChange={(e) => {
										const f = e.target.files?.[0];
										if (f) openFile(f);
										e.target.value = "";
									}}
								/>
							</label>
						</div>
						<p className="mt-1 text-xs text-neutral-500">
							Or drag &amp; drop a JPEG, HEIC, PNG, WebP or AVIF onto the photo
							area.
						</p>
						{samplesError && (
							<div className="mt-2">
								<Notice tone="error">{samplesError}</Notice>
							</div>
						)}
						{photo?.metaError && (
							<div className="mt-2">
								<Notice tone="error">
									Could not read metadata: {photo.metaError}
								</Notice>
							</div>
						)}
						{meta && (
							<dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-xs text-neutral-600">
								<dt>Camera</dt>
								<dd>{meta.model ?? "—"}</dd>
								<dt>Taken</dt>
								<dd>{meta.takenAt?.replace("T", " ").slice(0, 16) ?? "—"}</dd>
								<dt>Heading</dt>
								<dd>
									{meta.heading !== undefined
										? `${meta.heading.toFixed(1)}° ${meta.headingRef === "M" ? "(magnetic)" : ""}`
										: "—"}
								</dd>
								<dt>Focal</dt>
								<dd>{meta.focal35 ? `${meta.focal35} mm (35 mm eq.)` : "—"}</dd>
								<dt>GPS</dt>
								<dd>
									{meta.lat !== undefined
										? `±${meta.gpsError?.toFixed(0) ?? "?"} m, alt ${meta.altitude?.toFixed(0) ?? "?"} m`
										: "missing"}
								</dd>
							</dl>
						)}
						{prior && prior.missing.length > 0 && (
							<div className="mt-2">
								<Notice>
									Metadata lacks {prior.missing.join(", ")}; the starting camera
									is a guess (level, heading{" "}
									{meta?.heading !== undefined ? "from EXIF" : "north"}). Drag
									the photo or use tap-peaks to align.
								</Notice>
							</div>
						)}
					</Section>

					<Section title="Location">
						{noGps && (
							<div className="mb-2">
								<Notice>
									No GPS in this photo. iOS Safari strips location from uploads
									unless you tap <b>Options → Location</b> in the photo picker.
									Enter the position manually:
								</Notice>
							</div>
						)}
						<div className="flex items-end gap-2">
							<label className="min-w-0 flex-1 text-xs text-neutral-600">
								Lat
								<input
									inputMode="decimal"
									className="mt-0.5 w-full rounded-md border border-neutral-300 px-2 py-1 font-mono text-sm"
									value={manual.lat}
									placeholder="46.7085"
									onChange={(e) =>
										setManual({ ...manual, lat: e.target.value })
									}
								/>
							</label>
							<label className="min-w-0 flex-1 text-xs text-neutral-600">
								Lon
								<input
									inputMode="decimal"
									className="mt-0.5 w-full rounded-md border border-neutral-300 px-2 py-1 font-mono text-sm"
									value={manual.lon}
									placeholder="7.7302"
									onChange={(e) =>
										setManual({ ...manual, lon: e.target.value })
									}
								/>
							</label>
							<Button onClick={applyManual} disabled={!photo}>
								Use
							</Button>
						</div>
						{location && (
							<p className="mt-2 text-xs text-neutral-600">
								Using {location.lat.toFixed(5)}, {location.lon.toFixed(5)}
								{location.manual ? " (manual)" : " (EXIF)"}
								{state.horizon &&
									` · eye ${state.horizon.eye.toFixed(0)} m (DEM ground ${state.horizon.ground.toFixed(0)} m) · horizon ${(state.horizon.ms / 1000).toFixed(1)} s`}
							</p>
						)}
						{progress && (
							<div className="mt-2">
								<div className="text-xs text-neutral-600">
									{progress.message}
								</div>
								{progress.total ? (
									<div className="mt-1 h-1.5 overflow-hidden rounded bg-neutral-200">
										<div
											className="h-full bg-neutral-800 transition-[width]"
											style={{
												width: `${(100 * (progress.done ?? 0)) / progress.total}%`,
											}}
										/>
									</div>
								) : null}
							</div>
						)}
						{state.errors.tiles && (
							<div className="mt-2">
								<Notice tone="error">{state.errors.tiles}</Notice>
							</div>
						)}
						{state.errors.peaks && (
							<div className="mt-2">
								<Notice>Peaks unavailable: {state.errors.peaks}</Notice>
							</div>
						)}
						{state.peaks && (
							<p className="mt-1 text-xs text-neutral-500">
								{state.peaks.views.filter((v) => v.visible).length} visible
								peaks of {state.peaks.views.length}
							</p>
						)}
					</Section>

					<Section
						title="Camera"
						right={
							<Button onClick={resetToPrior} disabled={!prior}>
								Reset to prior
							</Button>
						}
					>
						{params && prior ? (
							<div className="space-y-2">
								<Slider
									label="Yaw"
									value={wrap180(params.yaw - prior.cam.yaw)}
									display={`${wrap360(params.yaw).toFixed(2)}°`}
									min={-30}
									max={30}
									step={0.05}
									onChange={(v) =>
										setParams({ ...params, yaw: prior.cam.yaw + v })
									}
								/>
								<Slider
									label="Pitch"
									value={params.pitch}
									display={`${params.pitch.toFixed(2)}°`}
									min={Math.round(prior.cam.pitch) - 25}
									max={Math.round(prior.cam.pitch) + 25}
									step={0.05}
									onChange={(v) => setParams({ ...params, pitch: v })}
								/>
								<Slider
									label="Roll"
									value={params.roll}
									display={`${params.roll.toFixed(2)}°`}
									min={Math.round(prior.cam.roll) - 20}
									max={Math.round(prior.cam.roll) + 20}
									step={0.05}
									onChange={(v) => setParams({ ...params, roll: v })}
								/>
								<Slider
									label="Horizontal FOV"
									value={hfov(params)}
									display={`${hfov(params).toFixed(1)}° · f ${params.f.toFixed(0)} px`}
									min={10}
									max={110}
									step={0.1}
									onChange={(v) =>
										setParams({
											...params,
											f: params.width / 2 / Math.tan(v / 2 / DEG),
										})
									}
								/>
								<p className="text-xs text-neutral-500">
									Prior: yaw {wrap360(prior.cam.yaw).toFixed(1)}°, pitch{" "}
									{prior.cam.pitch.toFixed(1)}°, roll{" "}
									{prior.cam.roll.toFixed(1)}°, HFOV{" "}
									{hfov(cameraParams(prior.cam)).toFixed(1)}°. Drag the photo to
									adjust yaw/pitch.
								</p>
								<div className="flex flex-wrap items-center gap-2 pt-1">
									<Button
										primary
										disabled={!canAlign}
										onClick={() =>
											cam &&
											state.sky &&
											align(resizeCamera(cam, state.sky.width))
										}
									>
										{state.aligning ? "Aligning…" : "Auto-align"}
									</Button>
									{state.align && (
										<span className="text-xs text-neutral-600">
											{state.align.method === "refine" ? "refined · " : ""}
											confidence {state.align.confidence.toFixed(2)}
											{Number.isFinite(state.align.residualPx) &&
												` · residual ${state.align.residualPx.toFixed(1)} px @ ${state.sky?.width ?? SKYLINE_WIDTH} px`}
										</span>
									)}
								</div>
								{state.align && !state.align.accepted && (
									<Notice>
										Auto-align not confident
										{state.align.rejectReason
											? ` (${state.align.rejectReason})`
											: ""}
										; camera left unchanged. Align manually or use tap-peaks.{" "}
										<button
											type="button"
											className="underline"
											onClick={applyAlign}
										>
											Apply anyway
										</button>
									</Notice>
								)}
								{!state.sky && img && !state.errors.skyline && (
									<p className="text-xs text-neutral-500">
										Detecting photo skyline…
									</p>
								)}
								{state.errors.skyline && (
									<Notice tone="error">
										Skyline detection failed: {state.errors.skyline}
									</Notice>
								)}
								{state.errors.align && (
									<Notice tone="error">
										Auto-align failed: {state.errors.align}
									</Notice>
								)}
							</div>
						) : (
							<p className="text-sm text-neutral-500">Load a photo first.</p>
						)}
					</Section>

					<Section title="Layers">
						<div className="space-y-1.5">
							<div className="flex items-center gap-2 text-sm">
								<span className="inline-block h-0.5 w-5 bg-[rgb(255,40,200)]" />
								Predicted skyline (DEM)
							</div>
							<div className="flex items-center gap-2 text-sm">
								<span className="inline-block w-5 border-t border-dashed border-neutral-500" />
								Geometric horizon (0°)
							</div>
							<Toggle
								label="Ridge crests (near → far)"
								checked={layers.ridges}
								onChange={(v) => setLayers({ ...layers, ridges: v })}
								swatch={
									<span className="flex">
										{Array.from({ length: RIDGE_BUCKETS }, (_, b) => (
											<span
												// biome-ignore lint/suspicious/noArrayIndexKey: fixed buckets
												key={b}
												className="h-2 w-1.5"
												style={{ background: bucketColor(b) }}
											/>
										))}
									</span>
								}
							/>
							<Toggle
								label="Peak labels"
								checked={layers.peaks}
								onChange={(v) => setLayers({ ...layers, peaks: v })}
							/>
							<Toggle
								label="Detected photo skyline"
								checked={layers.detected}
								onChange={(v) => setLayers({ ...layers, detected: v })}
								swatch={
									<span className="inline-block h-0.5 w-5 bg-[var(--rigi-glow)]" />
								}
							/>
						</div>
					</Section>

					<Section
						title="Tap peaks"
						right={
							<Button
								active={tapMode}
								disabled={!cam}
								onClick={() => {
									setTapMode(!tapMode);
									setPending(null);
									setTapHint(null);
								}}
							>
								{tapMode ? "Done" : "Start"}
							</Button>
						}
					>
						<p className="text-xs text-neutral-500">
							Tap a peak label (or a point on the magenta skyline), then tap
							where it really is in the photo. The camera is re-solved after
							each point.
						</p>
						{pending && (
							<div className="mt-2 flex items-center justify-between text-sm">
								<span>
									Selected: <b>{pending.label}</b>
								</span>
								<button
									type="button"
									className="text-xs text-neutral-500 underline"
									onClick={() => setPending(null)}
								>
									cancel
								</button>
							</div>
						)}
						{points.length > 0 && (
							<ul className="mt-2 divide-y divide-neutral-100 text-sm">
								{points.map((p) => (
									<li
										key={p.id}
										className="flex items-center justify-between py-1"
									>
										<span>
											<span className="mr-1 font-mono text-amber-600">
												{p.id}
											</span>
											{p.label}
											<span className="ml-1 text-xs text-neutral-500">
												az {p.azimuth.toFixed(1)}°
												{cam && ` · ${pointErrPx(cam, p).toFixed(1)} px`}
											</span>
										</span>
										<button
											type="button"
											className="text-xs text-neutral-500 hover:text-red-600"
											onClick={() => removePoint(p.id)}
										>
											remove
										</button>
									</li>
								))}
							</ul>
						)}
						{cpRms !== null && points.length >= 2 && (
							<p className="mt-1 text-xs text-neutral-600">
								RMS {cpRms.toFixed(1)} px ({points.length} points)
							</p>
						)}
						{points.length > 0 && (
							<button
								type="button"
								className="mt-1 text-xs text-neutral-500 underline"
								onClick={() => {
									setPoints([]);
									setCpRms(null);
								}}
							>
								clear all
							</button>
						)}
					</Section>
				</aside>
			</div>
		</div>
	);
}
