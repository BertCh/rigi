// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	AlertTriangle,
	Check,
	Compass,
	ImagePlus,
	Loader2,
	MapPin,
	Mountain,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SiteNav } from "#/components/site/SiteNav";
import { hfovFromVfov } from "#/lib/camera";
import { DEG as D, EARTH_R } from "#/lib/geodesy";
import type { RegionData } from "#/lib/photos";
import {
	deleteLocalPhoto,
	HeicUnsupportedError,
	hasPosition,
	type LocalPhotoMeta,
	type LocalPhotoSummary,
	type LocalRegion,
	listLocalPhotos,
	prepareUpload,
	regionFor,
	registerHook,
	registerWithWorkspace,
	restoreLocalPhoto,
	saveUpload,
	type UploadDraft,
	type UploadStage,
	withPosition,
} from "#/lib/upload";
import {
	type CoachInput,
	coachLocation,
	isIosUserAgent,
} from "#/lib/upload/coach";
import {
	LGPL_TEXT,
	LIBHEIF_FILE_URL,
	THIRD_PARTY,
} from "#/lib/upload/licenses";
import { SlippyMap } from "#/lib/upload/SlippyMap";

export const Route = createFileRoute("/upload")({
	ssr: false,
	head: () => ({ meta: [{ title: "Upload · Rigi" }] }),
	component: UploadPage,
});

type RegionState =
	| { kind: "idle" }
	| { kind: "loading"; stage: string }
	| { kind: "ready"; region: LocalRegion }
	| { kind: "error"; message: string };

const STAGE_LABEL: Record<UploadStage, string> = {
	reading: "Reading file…",
	exif: "Reading EXIF…",
	decoding: "Decoding image…",
	done: "Done",
};

function distBearing(lat0: number, lon0: number, lat1: number, lon1: number) {
	const dLat = (lat1 - lat0) * D;
	const dLon = (lon1 - lon0) * D;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat0 * D) * Math.cos(lat1 * D) * Math.sin(dLon / 2) ** 2;
	const d = 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
	const y = Math.sin(dLon) * Math.cos(lat1 * D);
	const x =
		Math.cos(lat0 * D) * Math.sin(lat1 * D) -
		Math.sin(lat0 * D) * Math.cos(lat1 * D) * Math.cos(dLon);
	return { d, brg: (((Math.atan2(y, x) / D) % 360) + 360) % 360 };
}

function UploadPage() {
	const navigate = useNavigate();
	const [stage, setStage] = useState<UploadStage | null>(null);
	const [error, setError] = useState<{
		message: string;
		heic?: boolean;
	} | null>(null);
	const [draft, setDraft] = useState<UploadDraft | null>(null);
	const [meta, setMeta] = useState<LocalPhotoMeta | null>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [region, setRegion] = useState<RegionState>({ kind: "idle" });
	const [saved, setSaved] = useState<{
		meta: LocalPhotoMeta;
		region: RegionData;
	} | null>(null);
	const [saving, setSaving] = useState(false);
	const [library, setLibrary] = useState<LocalPhotoSummary[]>([]);
	const [dragOver, setDragOver] = useState(false);
	const [regionNonce, setRegionNonce] = useState(0);
	const skipRef = useRef<(() => void) | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const fileSeq = useRef(0);
	const hook = registerHook();

	const refreshLibrary = useCallback(() => {
		listLocalPhotos().then(setLibrary);
	}, []);
	useEffect(refreshLibrary, [refreshLibrary]);

	useEffect(() => {
		if (!draft) return;
		const u = URL.createObjectURL(draft.decoded.blob);
		setPreviewUrl(u);
		return () => URL.revokeObjectURL(u);
	}, [draft]);

	const onFile = useCallback(async (file: File | undefined) => {
		if (!file) return;
		const token = ++fileSeq.current;
		const current = () => token === fileSeq.current;
		setError(null);
		setDraft(null);
		setMeta(null);
		setSaved(null);
		setRegion({ kind: "idle" });
		try {
			const d = await prepareUpload(file, (s) => current() && setStage(s));
			// a newer file was picked while this one decoded: drop this result
			if (!current()) return;
			setDraft(d);
			setMeta(d.meta);
		} catch (e) {
			if (!current()) return;
			console.error("[upload]", e);
			setError({
				message: (e as Error).message,
				heic: e instanceof HeicUnsupportedError,
			});
		} finally {
			if (current()) setStage(null);
		}
	}, []);

	// position known → fetch OSM region (cached) → persist the upload
	const posKey =
		meta && hasPosition(meta)
			? `${meta.lat.toFixed(6)},${meta.lon.toFixed(6)}`
			: null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: regionNonce is the Retry trigger
	useEffect(() => {
		if (!draft || !meta || !posKey) return;
		const ctl = new AbortController();
		let dead = false;
		let skipped = false;
		skipRef.current = () => {
			skipped = true;
			ctl.abort(new DOMException("skipped", "AbortError"));
		};
		setSaved(null);
		setRegion({ kind: "loading", stage: "checking cache" });
		const stageText = {
			cache: "checking cache",
			peaks: "peaks from Overpass",
			trails: "trails",
			water: "lakes",
			done: "done",
		};
		regionFor(meta, {
			signal: ctl.signal,
			onProgress: (s) =>
				!dead && setRegion({ kind: "loading", stage: stageText[s] }),
		})
			.then((r) => {
				if (dead) return null;
				setRegion({ kind: "ready", region: r });
				return r;
			})
			.catch((e) => {
				if (dead) return null;
				setRegion({
					kind: "error",
					message: skipped ? "skipped" : (e as Error).message,
				});
				return null;
			})
			.then(async (r) => {
				if (dead) return;
				setSaving(true);
				try {
					const s = await saveUpload(draft, meta, r);
					if (!dead) setSaved(s);
					refreshLibrary();
				} catch (e) {
					if (!dead)
						setError({
							message: `Could not store the photo: ${(e as Error).message}`,
						});
				} finally {
					if (!dead) setSaving(false);
				}
			});
		return () => {
			dead = true;
			ctl.abort();
		};
	}, [draft, meta, posKey, regionNonce, refreshLibrary]);

	const openInWorkspace = (m: LocalPhotoMeta, r: RegionData) => {
		if (!registerWithWorkspace(m, r)) return;
		navigate({ to: "/photo/$id", params: { id: m.id } });
	};

	const openStored = async (id: string) => {
		const r = await restoreLocalPhoto(id);
		if (r) openInWorkspace(r.meta, r.region);
	};

	const settled = !stage && !saving && region.kind !== "loading";
	const diag = draft?.diagnostics;

	return (
		<main
			className="min-h-dvh bg-[var(--rigi-ink)] px-4 pb-16 text-white sm:px-8"
			data-ready={settled ? "" : undefined}
			data-stage={
				stage ??
				(region.kind === "loading"
					? "region"
					: saved
						? "saved"
						: draft
							? "parsed"
							: "idle")
			}
		>
			{/* <main> sets the gutter here */}
			<SiteNav active="library" className="px-0 sm:px-0" />
			<header className="mx-auto max-w-6xl pt-8 pb-5">
				<p className="flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-[var(--rigi-glow)] uppercase">
					<Compass className="size-3.5" /> Add a photo
				</p>
			</header>

			<section className="mx-auto max-w-6xl">
				<label
					htmlFor="upload-input"
					onDragOver={(e) => {
						e.preventDefault();
						setDragOver(true);
					}}
					onDragLeave={() => setDragOver(false)}
					onDrop={(e) => {
						e.preventDefault();
						setDragOver(false);
						onFile(e.dataTransfer.files[0]);
					}}
					className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md px-6 py-10 text-center transition ${
						dragOver
							? "bg-[var(--rigi-glow)]/10 ring-2 ring-[var(--rigi-glow)]"
							: "bg-white/[0.03] hover:bg-white/[0.06]"
					}`}
				>
					{stage ? (
						<Loader2 className="size-7 animate-spin text-[var(--rigi-glow)]" />
					) : (
						<ImagePlus className="size-7 text-[var(--rigi-glow)]" />
					)}
					<span className="text-base font-semibold">
						{stage
							? STAGE_LABEL[stage]
							: "Drop a phone photo here, or click to choose"}
					</span>
					<span className="max-w-xl text-xs leading-relaxed text-white/50">
						HEIC, JPEG, PNG, WebP or AVIF, from any phone or camera. GPS,
						compass heading and lens give the starting camera pose (iPhones also
						record the gravity sensor, which pins tilt and roll). Nothing leaves
						your browser except the map-data query to OpenStreetMap.
					</span>
					<input
						id="upload-input"
						ref={inputRef}
						type="file"
						accept="image/jpeg,image/heic,image/heif,image/png,image/webp,image/avif,.jpg,.jpeg,.heic,.heif,.png,.webp,.avif"
						className="sr-only"
						data-testid="upload-input"
						onChange={(e) => {
							onFile(e.target.files?.[0]);
							e.target.value = "";
						}}
					/>
				</label>

				{error && (
					<div
						className="mt-4 rounded-md bg-red-500/10 p-4 text-sm text-red-200 light:text-[var(--rigi-trap)]"
						data-testid="upload-error"
					>
						<p className="flex items-center gap-2 font-semibold">
							<AlertTriangle className="size-4" />{" "}
							{error.heic ? "This browser cannot decode HEIC" : "Upload failed"}
						</p>
						<p className="mt-1 text-red-200/80 light:text-[var(--rigi-trap)]/80">
							{error.message}
						</p>
						{error.heic && (
							<p className="mt-2 text-red-200/80 light:text-[var(--rigi-trap)]/80">
								Please export the photo as JPEG (on iPhone: Settings → Camera →
								Formats → Most Compatible, or share the photo and choose
								"Options → Most Compatible"), or open this page in Safari, which
								decodes HEIC natively.
							</p>
						)}
					</div>
				)}
			</section>

			{draft && meta && (
				<section
					className="mx-auto mt-8 grid max-w-6xl gap-6 lg:grid-cols-[1.2fr_1fr]"
					data-testid="upload-result"
				>
					<div className="space-y-4">
						{/* without GPS the map is the next thing to do, so it goes above the preview */}
						<div
							className={`flex gap-4 ${hasPosition(draft.meta) ? "flex-col" : "flex-col-reverse"}`}
						>
							<div
								data-theme="dark"
								className="overflow-hidden rounded-md bg-black"
							>
								{previewUrl && (
									<img
										src={previewUrl}
										alt={meta.id}
										className="max-h-[60vh] w-full object-contain"
									/>
								)}
							</div>
							<div className="space-y-4">
								<Warnings meta={meta} diag={diag} />
								<PositionPanel
									meta={meta}
									onPick={(p) => setMeta(withPosition(draft, p.lat, p.lon))}
									onReset={() => setMeta(draft.meta)}
									canReset={draft.meta !== meta && hasPosition(draft.meta)}
								/>
							</div>
						</div>
					</div>

					<div className="space-y-4">
						<MetaTable meta={meta} draft={draft} />
						<PriorPose meta={meta} />
						<RegionPanel
							state={region}
							meta={meta}
							onRetry={() => setRegionNonce((n) => n + 1)}
							onSkip={() => skipRef.current?.()}
						/>
						<div className="rounded-md bg-white/[0.04] p-4">
							{!hasPosition(meta) ? (
								<p className="text-sm text-amber-200 light:text-[var(--rigi-lesson)]">
									Place the camera position on the map to continue.
								</p>
							) : saving || region.kind === "loading" ? (
								<p className="flex items-center gap-2 text-sm text-white/60">
									<Loader2 className="size-4 animate-spin" /> Preparing…
								</p>
							) : saved ? (
								<div className="space-y-3">
									<p
										className="flex items-center gap-2 text-sm text-emerald-300 light:text-[var(--rigi-result)]"
										data-testid="upload-saved"
									>
										<Check className="size-4" /> Saved on this device as{" "}
										<span className="font-mono">{saved.meta.id}</span>
									</p>
									<button
										type="button"
										disabled={!hook}
										data-testid="open-workspace"
										onClick={() => openInWorkspace(saved.meta, saved.region)}
										className="w-full rounded-lg bg-[var(--rigi-glow)] px-4 py-2.5 text-sm font-semibold text-[var(--rigi-ink)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40"
									>
										Open in workspace
									</button>
									{!hook && (
										<p className="text-xs text-white/45">
											The workspace can't open uploaded photos yet (it needs{" "}
											<code className="text-white/70">registerLocalPhoto</code>{" "}
											in photos.ts). Your photo is saved and will open once that
											lands.
										</p>
									)}
								</div>
							) : null}
						</div>
					</div>
				</section>
			)}

			{library.length > 0 && (
				<section className="mx-auto mt-12 max-w-6xl">
					<h2 className="mb-3 text-sm font-semibold text-white/70">
						Uploaded on this device{" "}
						<span className="text-white/35">· {library.length}</span>
					</h2>
					<div
						className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
						data-testid="upload-library"
					>
						{library.map((p) => (
							<div
								key={p.id}
								className="overflow-hidden rounded-md bg-white/[0.04]"
							>
								<button
									type="button"
									data-theme="dark"
									className="block aspect-[4/3] w-full bg-black disabled:cursor-default"
									disabled={!hook}
									onClick={() => openStored(p.id)}
									title={hook ? "Open in workspace" : undefined}
								>
									{p.thumbUrl && (
										<img
											src={p.thumbUrl}
											alt={p.id}
											className="size-full object-cover"
										/>
									)}
								</button>
								<div className="flex items-center justify-between px-3 py-2 text-[11px] text-white/55">
									<span
										className="truncate font-mono"
										title={p.meta.local?.fileName}
									>
										{p.meta.local?.fileName || p.id}
									</span>
									<button
										type="button"
										aria-label="Delete"
										className="text-white/40 hover:text-red-300 light:hover:text-[var(--rigi-trap)]"
										onClick={async () => {
											await deleteLocalPhoto(p.id);
											refreshLibrary();
										}}
									>
										<Trash2 className="size-3.5" />
									</button>
								</div>
							</div>
						))}
					</div>
				</section>
			)}

			<Credits />
		</main>
	);
}

function Credits() {
	return (
		<footer
			className="mx-auto mt-12 max-w-6xl text-[11px] leading-relaxed text-white/40"
			data-testid="upload-credits"
		>
			<details>
				<summary className="cursor-pointer hover:text-white/70">
					Credits and licences
				</summary>
				<p className="mt-2">
					Map tiles and peak/trail data © OpenStreetMap contributors (ODbL).
					HEIC decoding in browsers without native support uses the following
					libraries, loaded unmodified as a separate file (
					<a
						className="text-[var(--rigi-glow)] hover:underline"
						href={LIBHEIF_FILE_URL}
					>
						libheif bundle
					</a>
					) that you may replace with your own build (licence texts, including
					onnxruntime-web's third-party notices, are under{" "}
					<a
						className="text-cyan-300/80 light:text-[var(--rigi-glow)]/80 hover:underline"
						href="/licenses/README.txt"
					>
						/licenses
					</a>
					):
				</p>
				<ul className="mt-1 list-disc pl-5">
					{THIRD_PARTY.map((n) => (
						<li key={n.name}>
							<b className="text-white/60">{n.name}</b> {n.version} ·{" "}
							{n.license} · source:{" "}
							<a
								className="text-[var(--rigi-glow)] hover:underline"
								href={n.source}
								target="_blank"
								rel="noreferrer"
							>
								{n.source}
							</a>{" "}
							· {n.note}
						</li>
					))}
				</ul>
				<details className="mt-2">
					<summary className="cursor-pointer hover:text-white/70">
						GNU LGPL v3 / GPL v3 text
					</summary>
					<pre className="mt-2 max-h-80 overflow-auto rounded-md bg-black/40 p-3 whitespace-pre-wrap">
						{LGPL_TEXT}
					</pre>
				</details>
			</details>
		</footer>
	);
}

function Warnings({
	meta,
	diag,
}: {
	meta: LocalPhotoMeta;
	diag: UploadDraft["diagnostics"] | undefined;
}) {
	if (!diag) return null;
	const items: {
		title: string;
		body: React.ReactNode;
		tone: "amber" | "sky";
	}[] = [];
	if (diag.headingMagnetic)
		items.push({
			tone: "sky",
			title: "Magnetic heading",
			body: "The heading is relative to magnetic north (a few degrees off true north in the Alps). Alignment corrects small offsets.",
		});
	if (!diag.hasF35)
		items.push({
			tone: "sky",
			title: "Unknown lens",
			body: `No 35 mm-equivalent focal length. Assuming ${meta.f35} mm (iPhone main camera).`,
		});
	if (meta.local.timeSource === "exif-local")
		items.push({
			tone: "sky",
			title: "Capture time has no time zone",
			body: meta.local.tzEstimated
				? `The camera recorded local time without a zone, so UTC ${meta.tzOffset} was guessed from the longitude. Sun position and shadows may be off by an hour or more.`
				: "The camera recorded local time without a zone; it is read as UTC until a position is set. Sun position and shadows may be off by hours.",
		});
	if (diag.gpsAccuracy != null && diag.gpsAccuracy > 50)
		items.push({
			tone: "amber",
			title: "Imprecise GPS",
			body: `GPS accuracy was ±${Math.round(diag.gpsAccuracy)} m. Drag the pin if you know the exact spot.`,
		});
	return (
		<div className="space-y-2" data-testid="upload-warnings">
			<LocationCoach diag={diag} />
			{items.map((w) => (
				<div
					key={w.title}
					className={`rounded-md p-3 text-xs leading-relaxed ${w.tone === "amber" ? "bg-amber-400/10 text-amber-100/85 light:text-[var(--rigi-lesson)]/85 " : "bg-sky-400/10 text-sky-100/80 light:text-[var(--rigi-glow)]/80 "}`}
				>
					<p className="mb-0.5 flex items-center gap-1.5 font-semibold">
						<AlertTriangle className="size-3.5" /> {w.title}
					</p>
					{w.body}
				</div>
			))}
		</div>
	);
}

/** R7 coaching: which of position, heading and tilt the file carried, and how to record the rest. */
function LocationCoach({ diag }: { diag: CoachInput }) {
	const ios =
		typeof navigator !== "undefined" &&
		isIosUserAgent(navigator.userAgent, navigator.maxTouchPoints);
	const c = coachLocation(diag, { ios });
	const quiet = c.status === "complete";
	return (
		<div
			className={`rounded-md p-3 text-xs leading-relaxed ${quiet ? "bg-[color-mix(in_oklab,var(--rigi-result)_8%,transparent)]" : "bg-[color-mix(in_oklab,var(--rigi-lesson)_10%,transparent)]"}`}
			data-testid="location-coach"
			data-status={c.status}
		>
			<p className="font-semibold text-white/85">{c.headline}</p>
			<ul className="mt-1.5 flex gap-4" aria-label="Sensor data in this photo">
				{c.sensors.map((s) => (
					<li
						key={s.id}
						className={`flex items-center gap-1.5 ${s.present ? "text-white/80" : "text-white/50"}`}
					>
						<span
							aria-hidden
							className={`inline-block size-2 rounded-full ${s.present ? "bg-[var(--rigi-result)]" : "ring-1 ring-current"}`}
						/>
						{s.label}
						<span className="sr-only">
							{s.present ? "recorded" : "missing"}
						</span>
					</li>
				))}
			</ul>
			{c.note && <p className="mt-2 text-white/60">{c.note}</p>}
			{c.steps.length > 0 && (
				<ol className="mt-2 list-decimal space-y-1 pl-4 text-white/70 marker:text-white/40">
					{c.steps.map((s) => (
						<li key={s.id}>{s.text}</li>
					))}
				</ol>
			)}
		</div>
	);
}

function PositionPanel({
	meta,
	onPick,
	onReset,
	canReset,
}: {
	meta: LocalPhotoMeta;
	onPick: (p: { lat: number; lon: number }) => void;
	onReset: () => void;
	canReset: boolean;
}) {
	const has = hasPosition(meta);
	// default view without GPS: the Alps
	const center = useMemo(
		() => (has ? { lat: meta.lat, lon: meta.lon } : { lat: 46.6, lon: 8.0 }),
		[has, meta.lat, meta.lon],
	);
	const [text, setText] = useState("");
	const parseText = () => {
		const m = text.match(/(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)/);
		if (!m) return;
		const lat = Number(m[1]);
		const lon = Number(m[2]);
		if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) onPick({ lat, lon });
	};
	return (
		<div className="rounded-md bg-white/[0.04] p-3">
			<div className="mb-2 flex items-center justify-between text-xs">
				<span className="flex items-center gap-1.5 font-semibold text-white/80">
					<MapPin className="size-3.5 text-red-400 light:text-[var(--rigi-trap)]" />
					{has
						? meta.local.positionSource === "pin"
							? "Pinned position"
							: "GPS position"
						: "Click the map where you stood"}
				</span>
				{canReset && (
					<button
						type="button"
						className="text-[var(--rigi-glow)] hover:underline"
						onClick={onReset}
					>
						Reset to GPS
					</button>
				)}
			</div>
			<SlippyMap
				center={center}
				zoom={has ? 14 : 8}
				pin={has ? { lat: meta.lat, lon: meta.lon } : null}
				accuracyM={meta.hAccuracy}
				headingDeg={meta.heading}
				hfovDeg={hfovFromVfov(meta.vfov, meta.width, meta.height)}
				onPick={onPick}
			/>
			<form
				className="mt-2 flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					parseText();
				}}
			>
				<input
					value={text}
					onChange={(e) => setText(e.target.value)}
					placeholder="or type lat, lon  (e.g. 46.6717, 7.7094)"
					className="min-w-0 flex-1 rounded-md bg-black/40 px-2 py-1.5 font-mono text-xs text-white outline-none focus:ring-1 focus:ring-[var(--rigi-glow)]/60"
				/>
				<button
					type="submit"
					className="rounded-md bg-white/10 px-3 text-xs hover:bg-white/15"
				>
					Set
				</button>
			</form>
			<p className="mt-1.5 text-[11px] text-white/40">
				Click to move the pin · drag to pan · scroll or double-click to zoom
			</p>
		</div>
	);
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
	return (
		<>
			<dt className="text-white/45">{k}</dt>
			<dd className="text-right font-mono text-white/80">{v}</dd>
		</>
	);
}

function MetaTable({
	meta,
	draft,
}: {
	meta: LocalPhotoMeta;
	draft: UploadDraft;
}) {
	const offset = meta.tzOffset?.match(/([+-])(\d\d):(\d\d)/);
	const offMin = offset
		? (offset[1] === "-" ? -1 : 1) *
			(Number(offset[2]) * 60 + Number(offset[3]))
		: 0;
	const local = new Date(new Date(meta.takenAt).getTime() + offMin * 60000);
	const f = (v: number | null | undefined, d = 1, u = "") =>
		v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(d)}${u}`;
	return (
		<div className="rounded-md bg-white/[0.04] p-4" data-testid="upload-meta">
			<h3 className="mb-2 text-sm font-semibold">
				{meta.local.fileName || meta.id}
			</h3>
			<dl className="grid grid-cols-2 gap-y-1 text-xs">
				<Row k="Id" v={meta.id} />
				<Row k="Camera" v={draft.diagnostics.model ?? "—"} />
				<Row
					k="Taken"
					v={`${local.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} ${meta.tzOffset ?? ""}${meta.local.timeSource === "file" ? " (file date)" : meta.local.tzEstimated ? " (zone guessed)" : ""}`}
				/>
				<Row
					k="Position"
					v={
						hasPosition(meta)
							? `${meta.lat.toFixed(5)}, ${meta.lon.toFixed(5)}`
							: "—"
					}
				/>
				<Row k="GPS altitude" v={f(meta.alt, 0, " m")} />
				<Row
					k="GPS accuracy"
					v={meta.hAccuracy == null ? "—" : `±${meta.hAccuracy.toFixed(0)} m`}
				/>
				<Row
					k="Heading"
					v={
						meta.heading == null
							? "unknown"
							: `${meta.heading.toFixed(1)}° ${meta.local.headingRef === "M" ? "mag" : "true"}`
					}
				/>
				<Row k="Focal length (35 mm)" v={`${meta.f35} mm`} />
				<Row
					k="Gravity (g)"
					v={
						meta.gravity
							? meta.gravity.map((g) => g.toFixed(3)).join(", ")
							: "—"
					}
				/>
				<Row k="Holding" v={meta.holding ?? "—"} />
				<Row
					k="Stored image"
					v={`${meta.width}×${meta.height} · ${(draft.decoded.blob.size / 1e6).toFixed(1)} MB · ${draft.decoded.decoder}`}
				/>
			</dl>
		</div>
	);
}

function PriorPose({ meta }: { meta: LocalPhotoMeta }) {
	const cell = (label: string, value: string, sub?: string) => (
		<div className="rounded-lg bg-black/30 px-3 py-2">
			<div className="text-[10px] tracking-wider text-white/40 uppercase">
				{label}
			</div>
			<div className="font-mono text-sm text-white">{value}</div>
			{sub && <div className="text-[10px] text-white/40">{sub}</div>}
		</div>
	);
	return (
		<div className="rounded-md bg-white/[0.04] p-4" data-testid="upload-prior">
			<h3 className="mb-2 text-sm font-semibold">Prior camera pose</h3>
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				{cell(
					"Yaw",
					meta.local.yawUnknown
						? "360° search"
						: `${meta.heading?.toFixed(2)}°`,
					"from true north",
				)}
				{cell(
					"Pitch",
					`${meta.pitch.toFixed(2)}°`,
					meta.gravity ? "gravity" : "default",
				)}
				{cell(
					"Roll",
					`${meta.roll.toFixed(2)}°`,
					meta.gravity ? "gravity" : "default",
				)}
				{cell(
					"V-FOV",
					`${meta.vfov.toFixed(2)}°`,
					`H ${hfovFromVfov(meta.vfov, meta.width, meta.height).toFixed(1)}°`,
				)}
			</div>
		</div>
	);
}

function RegionPanel({
	state,
	meta,
	onRetry,
	onSkip,
}: {
	state: RegionState;
	meta: LocalPhotoMeta;
	onRetry: () => void;
	onSkip: () => void;
}) {
	const nearest = useMemo(() => {
		if (state.kind !== "ready" || !hasPosition(meta)) return [];
		return state.region.peaks
			.map((p) => ({ ...p, ...distBearing(meta.lat, meta.lon, p.lat, p.lon) }))
			.filter((p) => p.ele != null)
			.sort(
				(a, b) =>
					(b.ele ?? 0) / Math.max(b.d, 2000) -
					(a.ele ?? 0) / Math.max(a.d, 2000),
			)
			.slice(0, 6);
	}, [state, meta]);
	return (
		<div className="rounded-md bg-white/[0.04] p-4" data-testid="upload-region">
			<h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
				<Mountain className="size-4 text-[var(--rigi-glow)]" /> Map data
				(OpenStreetMap)
			</h3>
			{state.kind === "idle" && (
				<p className="text-xs text-white/45">Waiting for a position.</p>
			)}
			{state.kind === "loading" && (
				<p className="flex items-center gap-2 text-xs text-white/60">
					<Loader2 className="size-3.5 animate-spin" /> Fetching {state.stage}…
					(this can take up to a minute)
					<button
						type="button"
						data-testid="skip-region"
						onClick={onSkip}
						className="ml-auto rounded-md bg-white/10 px-2 py-0.5 hover:bg-white/15"
					>
						Skip
					</button>
				</p>
			)}
			{state.kind === "error" && (
				<div className="text-xs text-amber-200/85 light:text-[var(--rigi-lesson)]/85">
					<p>
						{state.message === "skipped"
							? "Map data skipped."
							: `Couldn't load map data: ${state.message}`}
					</p>
					<p className="mt-1 text-white/45">
						The photo is saved without peaks and trails; alignment still works
						on terrain alone.
					</p>
					<button
						type="button"
						onClick={onRetry}
						className="mt-2 flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 hover:bg-white/15"
					>
						<RefreshCw className="size-3" /> Retry
					</button>
				</div>
			)}
			{state.kind === "ready" && (
				<div className="text-xs">
					<p className="text-white/70" data-testid="region-summary">
						<b className="text-white">{state.region.peaks.length}</b> named
						peaks within 60 km
						{state.region.waterNames.length
							? ` · ${state.region.waterNames.length} lakes`
							: ""}
					</p>
					{state.region.warnings?.map((w) => (
						<p
							key={w}
							className="mt-1 text-amber-200/80 light:text-[var(--rigi-lesson)]/80"
						>
							{w}
						</p>
					))}
					{nearest.length > 0 && (
						<ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
							{nearest.map((p) => (
								<li
									key={`${p.name}${p.lat}`}
									className="flex justify-between gap-2 text-white/60"
								>
									<span className="truncate">{p.name}</span>
									<span className="shrink-0 font-mono text-white/40">
										{Math.round(p.ele ?? 0)} m · {(p.d / 1000).toFixed(1)} km ·{" "}
										{Math.round(p.brg)}°
									</span>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}
