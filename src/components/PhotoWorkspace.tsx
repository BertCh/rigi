import { Link } from "@tanstack/react-router";
import {
	AlertTriangle,
	ArrowLeft,
	Crosshair,
	Download,
	Hand,
	Layers,
	Map as MapIcon,
	MapPin,
	Mountain,
	Plane,
	RotateCcw,
	ShieldCheck,
	Sparkles,
	Wand2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Pin } from "#/lib/align";
import { hfovFromAspect, type Pose } from "#/lib/camera";
import { useConcordDisplay } from "#/lib/concord/app/useConcordDisplay";
import type { WebGpuEngine } from "#/lib/deck-webgpu/engine";
import { ExportMenu } from "#/lib/export/ExportMenu";
import { getFlag } from "#/lib/flags";
import {
	type EyeSearchResult,
	persistPosition,
	photoAtEye,
} from "#/lib/gpu/eye/client";
import {
	choosePreview,
	type SecondOpinionVerdict,
	secondOpinion,
} from "#/lib/integration/second-opinion";
import {
	photoUnknowns,
	resolveUnknownPose,
	type UnknownPoseOutcome,
	UnknownPoseSolver,
} from "#/lib/integration/unknown-pose";
import { CreditLine } from "#/lib/licences/CreditLine";
import {
	boxLuma,
	type ClassicPlaced,
	candidatesFrom,
	canvasMeasure,
	contrastFilter,
	contrastNeed,
	type LumaMap,
	labelCssVars,
	labelSubText,
	layoutClassic,
	layoutLabels,
	lumaMapFrom,
	type PlacedLabel,
} from "#/lib/look/labels";
import { PeakLabelsSvg } from "#/lib/look/labels/PeakLabelsSvg";
import { useLabelFontEpoch } from "#/lib/look/labels/useLabelFonts";
import { needsPhotoSky } from "#/lib/look/look-key";
import type { AlignState } from "#/lib/ontology/crosswalk/pose";
import {
	formatTakenAt,
	loadRegion,
	loadSavedPose,
	type PhotoMeta,
	regionNames,
	savePose,
} from "#/lib/photos";
import { PickerMount } from "#/lib/picker/PickerMount";
import type { Renderer } from "#/lib/renderer";
import {
	probeWebGpu,
	type RendererChoice,
	type ResolvedRenderer,
	requestedRenderer,
	resolveRenderer,
} from "#/lib/renderer-select";
import { getRevealConfig, useRevealConfig } from "#/lib/reveal/config";
import { RevealController, type RevealFrame } from "#/lib/reveal/controller";
import { RevealPanel } from "#/lib/reveal/RevealPanel";
import {
	defaultSettings,
	type PeakLabel,
	type Sample,
	type Settings,
} from "#/lib/settings";
import { PRESET_MAP_LAYERS, PRESET_OVERLAY_LAYER, useViewStyle } from "#/lib/style";
import { uncertainOpacity, uncertainPrefix } from "#/lib/terroir/labels/names";
import {
	classicTier,
	decorateCandidates,
	resolvePeakClass,
} from "#/lib/terroir/labels/peakTiers";
import { useTierIndex } from "#/lib/terroir/labels/useTierIndex";
import { TerroirLayer } from "#/lib/terroir/ui/TerroirLayer";
import { TerroirPanel } from "#/lib/terroir/ui/TerroirPanel";
import { cn } from "#/lib/utils";
import {
	Button,
	PanelBand,
	Section,
	Segmented,
	Slider,
	Toggle,
} from "./controls";
import { EyeSuggestion } from "./EyeSuggestion";
import { CameraModeBar } from "./nearfield/CameraModeBar";
import { StepInsidePanel } from "./nearfield/StepInsidePanel";
import { Tiles3DCredit } from "./nearfield/Tiles3DCredit";
import { useStepInside } from "./nearfield/useStepInside";
import { AdvancedPanel } from "./panel/AdvancedPanel";
import { LabelStylePanel, StylePanel, TrailStylePanel } from "./StylePanel";

// Every backend loads on demand, so /photo downloads only the one it runs (src/lib/renderer-select.ts
// picks it): the deck.gl WebGpuEngine (src/lib/deck-webgpu/engine.ts) where WebGPU passes the probe, the
// WebGL DeckEngine (src/lib/deck/engine.ts) otherwise or with ?renderer=deck (the three.js PhotoEngine,
// ?renderer=three, was removed on 2026-10-01). One promise per backend, started when this module evaluates
// (below) so the engine chunk downloads alongside the first render instead of after the engine effect runs.
type MakeRenderer = (c: HTMLCanvasElement, p: PhotoMeta) => Renderer;
const rendererChunks = new Map<ResolvedRenderer, Promise<MakeRenderer>>();
function loadRenderer(kind: ResolvedRenderer): Promise<MakeRenderer> {
	let p = rendererChunks.get(kind);
	if (!p) {
		p = (
			kind === "webgpu"
				? import("#/lib/deck-webgpu/engine").then(
						({ WebGpuEngine }): MakeRenderer =>
							(c, p) =>
								new WebGpuEngine(c, p),
					)
				: import("#/lib/deck/engine").then(
						({ DeckEngine }): MakeRenderer =>
							(c, p) =>
								new DeckEngine(c, p),
					)
		).catch((e) => {
			rendererChunks.delete(kind); // a later mount retries a failed download
			throw e;
		});
		rendererChunks.set(kind, p);
	}
	return p;
}
const RENDERER_NAME: Record<ResolvedRenderer, string> = {
	webgpu: "WebGPU",
	deck: "deck",
};
if (typeof window !== "undefined") {
	// the effect reports failures; auto / webgpu start the WebGPU chunk and the probe together
	const want = requestedRenderer();
	if (want === "auto" || want === "webgpu") {
		if (getFlag("webgpu") !== "off") {
			loadRenderer("webgpu").catch(() => {});
			void probeWebGpu();
		} else loadRenderer("deck").catch(() => {});
	} else loadRenderer(want).catch(() => {});
}

type Tool = "inspect" | "align" | "pin";
/** terroir.subPill: a soft dark backing under the elevation · distance line */
const SUB_PILL = {
	display: "inline-block",
	background: "rgba(0,0,0,.35)",
	borderRadius: 6,
	padding: "0 4px",
} as const;

/** Same length and, per item, the same own fields (Object.is; array fields compared element-wise). */
function sameRecords<T extends object>(a: readonly T[], b: readonly T[]) {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] as Record<string, unknown>;
		const y = b[i] as Record<string, unknown>;
		const kx = Object.keys(x);
		if (kx.length !== Object.keys(y).length) return false;
		for (const k of kx) {
			const p = x[k];
			const q = y[k];
			if (Object.is(p, q)) continue;
			if (
				!Array.isArray(p) ||
				!Array.isArray(q) ||
				p.length !== q.length ||
				p.some((v, j) => !Object.is(v, q[j]))
			)
				return false;
		}
	}
	return true;
}

export function PhotoWorkspace({
	photo: photoIn,
	bundledPose = null,
}: {
	photo: PhotoMeta;
	/** A pose shipped with the photo (the sample trip): used like a saved pose when there is none. */
	bundledPose?: Pose | null;
}) {
	// opt-in eye-position suggestion (EyeSuggestion.tsx): an applied move re-creates the engine at the
	// moved eye with the re-fitted rotation; null = the photo's own GPS position
	const [eyeMove, setEyeMove] = useState<{
		photo: PhotoMeta;
		pose: Pose;
		note: string;
		prevSaved: Pose | null;
	} | null>(null);
	const eyeMoveRef = useRef(eyeMove);
	eyeMoveRef.current = eyeMove;
	const photo = eyeMove?.photo ?? photoIn;
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const engineRef = useRef<Renderer | null>(null);
	const [status, setStatus] = useState<{ msg: string; frac: number } | null>({
		msg: "Starting",
		frac: 0,
	});
	const [error, setError] = useState<string | null>(null);
	// the engine that actually runs ([data-renderer]); a WebGpuEngine that failed to start sets
	// rendererFallback, which re-mounts the canvas (keyed on it) and re-runs the engine effect on WebGL deck
	const [rendererUsed, setRendererUsed] = useState<RendererChoice | null>(null);
	const [rendererFallback, setRendererFallback] = useState<string | null>(null);
	// a mid-session WebGPU failure carries the live pose over to the WebGL deck that replaces it
	const carryRef = useRef<{ pose: Pose; align: AlignState | null } | null>(
		null,
	);
	const [settings, setSettings] = useState<Settings>(() => ({
		...defaultSettings,
		// near terrain is only as good as the GPS fix
		nearFade:
			Math.round(
				Math.min(200, Math.max(30, (photo.hAccuracy ?? 20) * 3)) / 10,
			) * 10,
	}));
	const settingsRef = useRef(settings);
	settingsRef.current = settings;
	// overlay reveal (src/lib/reveal): plays once the terrain is ready, replayable from the sidebar
	const [revealCfg, setRevealCfg] = useRevealConfig();
	const revealRef = useRef<RevealController | null>(null);
	const [revealFrame, setRevealFrame] = useState<RevealFrame | null>(null);
	const [pose, setPoseState] = useState<Pose | null>(null);
	const [labels, setLabels] = useState<PeakLabel[]>([]);
	const [candidates, setCandidates] = useState<PeakLabel[]>([]);
	const [showPeaks, setShowPeaks] = useState(true);
	const [tool, setTool] = useState<Tool>("inspect");
	const [hover, setHover] = useState<
		(Sample & { u: number; v: number; source?: "object" }) | null
	>(null);
	const [pins, setPins] = useState<Pin[]>([]);
	const [pendingPeak, setPendingPeak] = useState<PeakLabel | null>(null);
	const [alignNote, setAlignNote] = useState<string>("");
	const [alignState, setAlignState] = useState<AlignState | null>(null);
	const alignStateRef = useRef(alignState);
	alignStateRef.current = alignState;
	const unknownAbort = useRef<AbortController | null>(null);
	const unknownSolver = useRef<UnknownPoseSolver | null>(null);
	/** background second opinion on autoAlign (full metadata only): "pending" until it settles */
	const [verify, setVerify] = useState<SecondOpinionVerdict | "pending" | null>(
		null,
	);
	const verifyAbort = useRef<AbortController | null>(null);
	const [stageSize, setStageSize] = useState({ w: 0, h: 0, left: 0, top: 0 });
	// the latest measured stage size, for an engine that arrives after the first measure (lazy chunk)
	const stageSizeRef = useRef({ w: 0, h: 0 });
	const [flying, setFlying] = useState(false);
	const [hasPeople, setHasPeople] = useState(false);
	const aspect = photo.width / photo.height;
	const unknowns = useMemo(() => photoUnknowns(photo), [photo]);
	// how the views look (src/lib/style): global per user, persisted, ?style=<preset> overrides
	const [viewStyle, styleState] = useViewStyle();
	const styleRef = useRef(viewStyle);
	styleRef.current = viewStyle;
	/** The photo's P(sky), only for looks that use it: #/lib/sky and its model never load for classic. */
	const skyFor = useRef(new WeakSet<Renderer>());
	const loadSky = useCallback((engine: Renderer | null) => {
		const img = engine?.photoElement;
		if (
			!engine?.setSkyMask ||
			!img ||
			!needsPhotoSky(styleRef.current) ||
			skyFor.current.has(engine)
		)
			return;
		skyFor.current.add(engine);
		import("#/lib/sky")
			.then((m) => m.segmentSky(img))
			.then((mask) => engineRef.current === engine && engine.setSkyMask?.(mask))
			.catch((e) => console.warn("[sky] segmentation failed", e));
	}, []);
	// terroir label options (peakTiers / subPill / uncertainty): inert unless their style.terroir switch is on
	const tierIdx = useTierIndex(
		photo.lat,
		photo.lon,
		viewStyle.terroir.peakTiers,
	);
	const labelsUncertain =
		viewStyle.terroir.uncertainty &&
		(alignState === "unverified" || alignState === "prior");
	const labelsSubPill = viewStyle.terroir.subPill;
	const peakClassOf = useMemo(
		() =>
			viewStyle.terroir.peakTiers
				? (l: PeakLabel) => {
						const w = l.world;
						const g = engineRef.current?.frame.toGeo(w[0], w[1], w[2]) ?? null;
						return resolvePeakClass(tierIdx, l, g);
					}
				: null,
		[viewStyle.terroir.peakTiers, tierIdx],
	);
	/** a small luminance map of the photo: labels on bright cloud / snow get a stronger halo */
	const [lumaMap, setLumaMap] = useState<LumaMap | null>(null);
	const labelNeed = useCallback(
		(box: { x0: number; y0: number; x1: number; y1: number }) =>
			lumaMap && stageSize.w
				? contrastNeed(
						viewStyle.labels,
						boxLuma(lumaMap, box, stageSize.w, stageSize.h),
					)
				: 0,
		[lumaMap, stageSize.w, stageSize.h, viewStyle.labels],
	);
	const placedNeed = useCallback(
		(l: PlacedLabel) => {
			const xs = l.quad.map((q) => q[0]);
			const ys = l.quad.map((q) => q[1]);
			return labelNeed({
				x0: Math.min(...xs),
				y0: Math.min(...ys),
				x1: Math.max(...xs),
				y1: Math.max(...ys),
			});
		},
		[labelNeed],
	);
	const labelVars = useMemo(
		() => labelCssVars(viewStyle.labels),
		[viewStyle.labels],
	);
	/** the last fresh skyline (it lags a drag) and the previous layout (hysteresis) for the panorama / inline labels */
	const skylineRef = useRef<Float32Array | null>(null);
	const placedRef = useRef<PlacedLabel[]>([]);
	/** bumps once the label web font has loaded: re-run both layouts with its real widths */
	const fontEpoch = useLabelFontEpoch();
	// biome-ignore lint/correctness/useExhaustiveDependencies: fontEpoch invalidates cached text widths
	const placed = useMemo(() => {
		const ls = viewStyle.labels;
		if (ls.layout === "classic" || !stageSize.w) return [];
		const skyline = skylineRef.current;
		const opts = {
			width: stageSize.w,
			height: stageSize.h,
			fontPx: ls.name.px,
			style: ls.layout,
			skyline: skyline ?? undefined,
			measure: canvasMeasure,
			maxLabels: ls.maxLabels,
			fontFamily: ls.fontFamily,
		};
		const cands = candidatesFrom(labels, stageSize.w, stageSize.h, skyline);
		placedRef.current = layoutLabels(
			peakClassOf || labelsUncertain
				? decorateCandidates(cands, labels, peakClassOf, labelsUncertain)
				: cands,
			opts,
			placedRef.current,
		);
		return placedRef.current;
	}, [
		labels,
		stageSize.w,
		stageSize.h,
		viewStyle.labels,
		fontEpoch,
		peakClassOf,
		labelsUncertain,
	]);
	/** classic: wrapped, edge-clamped text blocks kept above their summits (look/labels/classic.ts) */
	const classicRef = useRef<ClassicPlaced[]>([]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: fontEpoch invalidates cached text widths
	const classicPlaced = useMemo(() => {
		const ls = viewStyle.labels;
		if (ls.layout !== "classic" || !stageSize.w) return [];
		classicRef.current = layoutClassic(
			labels.map((l) => ({
				id: l.name + l.world[0],
				name: labelsUncertain ? uncertainPrefix(l.distKm) + l.name : l.name,
				sub: labelSubText(l, ls.sub.show),
				x: l.u * stageSize.w,
				y: l.v * stageSize.h,
				...(peakClassOf ? { scale: classicTier(peakClassOf(l)).scale } : null),
			})),
			{
				width: stageSize.w,
				height: stageSize.h,
				nameFont: `${ls.name.weight} ${ls.name.px}px ${ls.fontFamily}`,
				subFont: `${ls.sub.weight} ${ls.sub.px}px ${ls.fontFamily}`,
				nameLineH: ls.name.px * 1.25,
				subLineH: ls.sub.px * 1.25,
				leadPx: ls.leader.lengthPx,
				dotPx: ls.dot.px,
				measure: canvasMeasure,
			},
			classicRef.current,
		);
		return classicRef.current;
	}, [
		labels,
		stageSize.w,
		stageSize.h,
		viewStyle.labels,
		fontEpoch,
		peakClassOf,
		labelsUncertain,
	]);
	const classicById = useMemo(
		() => new Map(classicPlaced.map((c) => [c.id, c])),
		[classicPlaced],
	);
	const missing = [
		unknowns.yaw && "compass",
		unknowns.gravity && "gravity",
		unknowns.focal && "lens",
	]
		.filter(Boolean)
		.join(" / ");

	const update = useCallback(
		(s: Partial<Settings>) => setSettings((prev) => ({ ...prev, ...s })),
		[],
	);
	// choosing a preset that is about a layer (Slope angle) switches the photo view to that layer; the
	// user can still pick another layer afterwards
	useEffect(() => {
		const layer = PRESET_OVERLAY_LAYER[styleState.preset];
		if (layer) update({ overlayStyle: layer });
		const maps = PRESET_MAP_LAYERS[styleState.preset];
		if (maps) update(maps);
	}, [styleState.preset, update]);

	const setPose = useCallback(
		(p: Pose, persist = true) => {
			setPoseState(p);
			engineRef.current?.setPose(p);
			if (persist) {
				savePose(photo.id, p);
				setAlignState("manual");
				// the user took over: a background second opinion or deferred match must not move the pose any more
				verifyAbort.current?.abort();
				unknownAbort.current?.abort();
				setVerify(null);
			}
		},
		[photo.id],
	);

	// engine lifecycle
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const create = (make: () => Renderer): Renderer | null => {
			try {
				return make();
			} catch (e) {
				setError(`WebGL unavailable: ${(e as Error).message}`);
				return null;
			}
		};
		// everything that needs the engine; returns the effect's cleanup for it
		const start = (engine: Renderer): (() => void) => {
			engineRef.current = engine;
			skylineRef.current = null;
			// either engine arrives after an async import: give it the settings changed meanwhile
			engine.setSettings(settingsRef.current);
			engine.setStyle?.(styleRef.current);
			// missing heading / gravity / focal: start the cascade's 360° terrain + horizon alongside the engine
			const solver = engine.unknowns.any ? new UnknownPoseSolver(photo) : null;
			unknownSolver.current = solver;
			// full metadata, no saved pose: the second opinion's worker starts its 360° terrain + horizon now,
			// in parallel with engine.init (a different tile origin, all off the main thread)
			let verifySolver =
				!solver &&
				!eyeMoveRef.current &&
				!(loadSavedPose(photo.id) ?? bundledPose)
					? new UnknownPoseSolver(photo)
					: null;
			if (import.meta.env.DEV) window.__engine = engine;
			const reveal = new RevealController(engine, (f) => {
				if (engineRef.current === engine) setRevealFrame(f);
			});
			revealRef.current = reveal;
			if (import.meta.env.DEV) window.__reveal = reveal;
			// keep the overlay hidden while the pose is solved, so it arrives with the flourish
			const revealOnLoad =
				getRevealConfig().onLoad &&
				settingsRef.current.mode !== "world" &&
				!carryRef.current;
			if (revealOnLoad) reveal.hold(getRevealConfig());
			const off = engine.onRender(() => {
				// every engine frame re-emits labels: keep the previous array when nothing changed, so React
				// (and the label layout memos keyed on it) skips the no-op re-render
				if (engine.settings.mode === "world") {
					setLabels((prev) => (prev.length ? [] : prev));
					setFlying(engine.isFlying);
					return;
				}
				const ls = styleRef.current.labels;
				// panorama / inline lay out every visible peak themselves (look/labels layout.ts)
				const next =
					ls.layout === "classic"
						? engine.peakLabels(ls.maxLabels)
						: engine.peakLabels(100, { declutter: false });
				// a fresh skyline re-runs the panorama / inline layout (it reads skylineRef) even when the
				// labels themselves are unchanged
				const sky = engine.skyline?.();
				const skyNew = !!sky && sky !== skylineRef.current;
				if (sky) skylineRef.current = sky;
				setLabels((prev) => (!skyNew && sameRecords(prev, next) ? prev : next));
				const cand = engine.peaksInFrame();
				setCandidates((prev) => (sameRecords(prev, cand) ? prev : cand));
			});
			(async () => {
				// Start everything at once: the ≈2 MB region JSON (2–11 s cold on the dev server) no longer
				// blocks the photo / tiles, and the segmentation model (≈20 MB) loads while they stream in.
				const region = loadRegion(photo.region).catch(() => null);
				const seg = import("#/lib/segment");
				seg.then((m) => m.preloadSegmenter()).catch(() => {});
				await engine.init(
					region,
					(msg, frac) => {
						if (engineRef.current === engine) setStatus({ msg, frac });
					},
					async (img) => (await seg).segmentForeground(img),
				);
				// StrictMode / fast navigation: a superseded engine must not touch shared state
				if (engineRef.current !== engine) return;
				loadSky(engine);
				// the photo's luminance, for backdrop-adaptive label contrast (labels/contrast.ts)
				const img = engine.photoElement;
				setLumaMap(img ? lumaMapFrom(img) : null);
				const ownSave = loadSavedPose(photo.id);
				const saved = ownSave ?? bundledPose;
				const moved = eyeMoveRef.current;
				let startVerify: (() => void) | null = null;
				const carried = carryRef.current;
				carryRef.current = null;
				if (carried) {
					setPose(carried.pose, false);
					setAlignState(carried.align);
				} else if (moved) {
					setPose(moved.pose, false);
					setAlignState("manual");
					// a pose the person chose: a verdict from an earlier (aborted) second opinion no longer applies
					setVerify(null);
					setAlignNote(moved.note);
				} else if (saved) {
					setPose(saved, false);
					setAlignState("saved");
					setVerify(null);
					setAlignNote(
						ownSave
							? "Restored your saved alignment"
							: "Sample alignment, solved on-device by the roll aligner",
					);
				} else if (solver && engine.photoElement) {
					// No compass / gravity / focal (uploads): autoAlign searches ±25° around a placeholder prior
					// and accepts wrong poses (reports/bench-ablation.md), so it is never trusted here.
					const ctl = new AbortController();
					unknownAbort.current = ctl;
					let out: UnknownPoseOutcome | null = null;
					try {
						out = await resolveUnknownPose(
							photo,
							solver,
							engine.photoElement,
							engine.prior,
							engine.unknowns,
							engine.prior,
							{
								signal: ctl.signal,
								onStage: (msg) =>
									engineRef.current === engine && setStatus({ msg, frac: 1 }),
							},
						);
					} catch (e) {
						// superseded by a newer solve (runAlign aborts this one and applies its own pose): the load
						// still has to finish below, or the overlay and [data-ready] never clear
						if (
							(e as Error)?.name !== "AbortError" ||
							engineRef.current !== engine
						)
							throw e;
					}
					if (engineRef.current !== engine) return;
					if (out) {
						setPose(out.pose, false);
						setAlignState(out.state);
						setAlignNote(out.note);
						// contended match service: the overlay cleared early on the guess; a confident match upgrades it
						out.upgrade?.then((up) => {
							if (!up || engineRef.current !== engine || ctl.signal.aborted)
								return;
							setPose(up.pose, false);
							setAlignState(up.state);
							setAlignNote(up.note);
						});
					} else setPoseState((p) => p ?? { ...engine.pose });
				} else {
					setStatus({ msg: "Aligning skyline to terrain", frac: 1 });
					await new Promise((r) => setTimeout(r, 30));
					const res = await engine.autoAlign(true);
					if (engineRef.current !== engine) return;
					// autoAlign at confidence > 0.2, else a near-compass alternative, else the prior
					const pre = choosePreview(res, engine.prior);
					const { app } = pre;
					setPose(app.pose, false);
					setAlignState(app.state);
					setAlignNote(pre.note);
					// Second opinion: 0f's CPU cascade in a worker (second-opinion.ts). It starts after first paint
					// and never delays [data-ready]; [data-verify] is "pending" until it settles.
					const img = engine.photoElement;
					if (img) {
						const ctl = new AbortController();
						verifyAbort.current = ctl;
						setVerify("pending");
						startVerify = () => {
							const t0 = performance.now();
							const early = verifySolver ?? undefined;
							verifySolver = null; // owned (and disposed) by secondOpinion from here
							secondOpinion(photo, img, engine.prior, app, {
								signal: ctl.signal,
								solver: early,
								onUnverified: (note) => {
									if (ctl.signal.aborted) return;
									setAlignState("unverified");
									setAlignNote(note);
								},
							})
								.then((out) => {
									if (engineRef.current !== engine || ctl.signal.aborted)
										return;
									const sinceReadyMs = Math.round(performance.now() - t0);
									console.debug("[second-opinion]", out.verdict, {
										disagreeDeg: out.disagreeDeg,
										cascade: JSON.stringify(out.cascade),
										matcher: out.matcher,
										sinceReadyMs,
									});
									if (import.meta.env.DEV)
										window.__secondOpinion = { ...out, sinceReadyMs };
									if (out.pose !== app.pose) setPose(out.pose, false);
									if (out.verdict === "unverified") setAlignState("unverified");
									else if (
										out.verdict === "refined" ||
										out.verdict === "matched"
									)
										setAlignState("accepted");
									if (out.note) setAlignNote(out.note);
									setVerify(out.verdict);
									// matcher busy: exports unlock now; a confident match later still takes over
									out.upgrade?.then((up) => {
										if (
											!up ||
											engineRef.current !== engine ||
											ctl.signal.aborted
										)
											return;
										setPose(up.pose, false);
										setAlignState("accepted");
										setAlignNote(up.note);
										setVerify(up.verdict);
									});
								})
								.catch((e) => {
									if (e?.name !== "AbortError")
										console.warn("[second-opinion]", e);
									if (!ctl.signal.aborted) setVerify(null);
								});
						};
					}
				}
				// [data-ready] means final labels: occlusion from a geometry buffer of THIS pose, not an empty
				// or previous-pose buffer (the debounced readback otherwise lands ≥90 ms later)
				await (engine.settle ? engine.settle() : engine.readback());
				if (engineRef.current !== engine) return;
				setStatus(null);
				setHasPeople(engine.hasPeople);
				if (import.meta.env.DEV)
					window.__poseAtReady = {
						...engine.pose,
					};
				if (revealOnLoad) {
					if (settingsRef.current.mode !== "world")
						reveal.play(getRevealConfig());
					else reveal.stop();
				}
				if (startVerify) startVerify();
				else {
					verifySolver?.dispose();
					verifySolver = null;
				}
			})().catch((e) => {
				// a disposed (StrictMode / navigated-away) engine rejects with AbortError: not an error
				if (engineRef.current === engine && e?.name !== "AbortError")
					setError(String(e?.message ?? e));
			});
			return () => {
				unknownAbort.current?.abort();
				verifyAbort.current?.abort();
				verifySolver?.dispose();
				solver?.dispose();
				unknownSolver.current = null;
				off();
				reveal.dispose();
				if (revealRef.current === reveal) revealRef.current = null;
				engine.dispose();
				engineRef.current = null;
			};
		};
		// the backend's chunk loads on demand (loadRenderer above); start() applies the settings and style
		// changed while it loaded
		let stop: (() => void) | null = null;
		let cancelled = false;
		let name = "deck";
		(rendererFallback
			? Promise.resolve<RendererChoice>({
					renderer: "deck",
					reason: rendererFallback.startsWith("device-lost")
						? rendererFallback
						: `fallback: ${rendererFallback}`,
				})
			: resolveRenderer()
		)
			.then(async (choice) => {
				name = RENDERER_NAME[choice.renderer];
				const make = await loadRenderer(choice.renderer);
				return { choice, make };
			})
			.then(
				async ({ choice, make }) => {
					if (cancelled) return;
					const engine = create(() => make(canvas, photo));
					if (!engine) return;
					if (choice.renderer === "webgpu") {
						// the WebGPU host boots asynchronously: a failure here falls back to WebGL deck on a fresh canvas
						try {
							await (engine as WebGpuEngine).whenReady();
						} catch (e) {
							engine.dispose();
							// the failed boot destroyed its device; compute must not keep it adopted
							import("#/lib/gpu/device")
								.then((m) => m.resetComputeDevice())
								.catch(() => {});
							if (cancelled) return;
							const why = `WebGPU init failed: ${(e as Error)?.message ?? e}`;
							console.warn(`[renderer] ${why}; falling back to WebGL deck`);
							setRendererFallback(why);
							return;
						}
						if (cancelled) {
							engine.dispose();
							return;
						}
					}
					setRendererUsed(choice);
					if (choice.renderer === "webgpu") {
						// mid-session: the device is lost and the engine could not rebuild (or keeps losing it).
						// Reuse the init fallback: dispose, re-mount a fresh canvas, run WebGL deck on the same state.
						const w = engine as WebGpuEngine;
						w.onUnrecoverable = (why) => {
							if (cancelled || engineRef.current !== engine) return;
							const msg = `device-lost: ${why}`;
							console.warn(
								`[renderer] WebGPU ${msg}; switching to WebGL deck (photo, pose and settings kept)`,
							);
							carryRef.current = {
								pose: { ...engine.pose },
								align: alignStateRef.current,
							};
							// compute must not keep the dead adopted device: it re-creates its own or uses the CPU
							import("#/lib/gpu/device")
								.then((m) => m.resetComputeDevice())
								.catch(() => {});
							setStatus({ msg: "Switching to WebGL", frac: 0 });
							setRendererFallback(msg);
						};
						window.__RIGI_FORCE_DEVICE_LOSS__ = (unrecoverable) =>
							unrecoverable
								? w.simulateUnrecoverableLoss()
								: w.simulateDeviceLoss();
					}
					try {
						stop = start(engine);
						// the stage measure ran before the chunk arrived: DeckEngine's constructor read canvas.clientWidth, which may predate layout
						const { w, h } = stageSizeRef.current;
						if (w && h) engine.resize(w, h);
					} catch (e) {
						// a half-started engine: release it (and its WebGL context) rather than leak it
						if (stop) stop();
						else {
							unknownSolver.current?.dispose();
							unknownSolver.current = null;
							engine.dispose();
							if (engineRef.current === engine) engineRef.current = null;
						}
						stop = null;
						setError(
							`${name} renderer failed to start: ${(e as Error).message}`,
						);
					}
				},
				(e) => {
					if (!cancelled)
						setError(
							`${name} renderer failed to load: ${(e as Error).message}`,
						);
				},
			);
		return () => {
			cancelled = true;
			stop?.();
			window.__RIGI_FORCE_DEVICE_LOSS__ = undefined;
		};
	}, [photo, setPose, loadSky, bundledPose, rendererFallback]);

	useEffect(() => {
		engineRef.current?.setSettings(settings);
	}, [settings]);

	// uploads fetch their hiking paths from Overpass only once the layer is switched on
	const trailsOn = settings.trails;
	useEffect(() => {
		if (!trailsOn || !photo.region.startsWith("local-")) return;
		const ctl = new AbortController();
		import("#/lib/upload/region")
			.then((m) => m.fetchRegionTrails(photo.region, { signal: ctl.signal }))
			.then((trails) => {
				// an engine still initialising keeps them until its region arrives
				if (trails && !ctl.signal.aborted)
					engineRef.current?.setTrails?.(trails);
			})
			.catch((e) => {
				if (!ctl.signal.aborted) console.warn("[trails]", e);
			});
		return () => ctl.abort();
	}, [trailsOn, photo.region]);

	// the engine re-renders (and re-emits labels) on a style change
	useEffect(() => {
		engineRef.current?.setStyle?.(viewStyle);
		loadSky(engineRef.current);
	}, [viewStyle, loadSky]);

	// stage sizing: photo views letterbox to the photo aspect; world view fills
	useEffect(() => {
		const el = stageRef.current;
		if (!el) return;
		const measure = () => {
			const W = el.clientWidth;
			const H = el.clientHeight;
			let w = W;
			let h = H;
			if (settings.mode !== "world") {
				if (W / H > aspect) w = Math.round(H * aspect);
				else h = Math.round(W / aspect);
			}
			stageSizeRef.current = { w, h };
			setStageSize({
				w,
				h,
				left: Math.round((W - w) / 2),
				top: Math.round((H - h) / 2),
			});
			engineRef.current?.resize(w, h);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [aspect, settings.mode]);

	// Step Inside (src/lib/nearfield): dormant and invisible unless the near-field service is running
	const si = useStepInside({
		engineRef,
		ready: !status && !error,
		photo,
		pose,
		alignState,
		verify,
		worldMode: settings.mode === "world",
	});

	// ---------- pointer interaction ----------
	const hoverGen = useRef(0);
	const drag = useRef<{
		x: number;
		y: number;
		pose: Pose;
		shift: boolean;
	} | null>(null);
	const pressed = useRef(false);

	const norm = (e: React.PointerEvent | React.WheelEvent) => {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		return {
			u: (e.clientX - r.left) / r.width,
			v: (e.clientY - r.top) / r.height,
		};
	};

	const onPointerDown = (e: React.PointerEvent) => {
		const eng = engineRef.current;
		if (!eng || !pose) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		pressed.current = true;
		const { u, v } = norm(e);
		if (tool === "align")
			drag.current = { x: e.clientX, y: e.clientY, pose, shift: e.shiftKey };
		else if (tool === "pin" && pendingPeak) {
			const key = pendingPeak.world.join();
			const next = [
				...pins.filter((p) => p.world.join() !== key),
				{ world: pendingPeak.world, u, v },
			];
			setPins(next);
			setPendingPeak(null);
			const solved = eng.solvePins(next);
			setPose(solved);
			setAlignState("pinned");
			setAlignNote(
				`Solved from ${next.length} pinned peak${next.length > 1 ? "s" : ""}`,
			);
		} else if (tool === "inspect" && settings.mode === "replace") {
			if (settings.method === "swipe") update({ swipe: u });
			if (settings.method === "brush") eng.paint(u, v, 0.05, e.altKey);
			if (settings.method === "lens") update({ lens: [u, v] });
		}
	};

	const onPointerMove = (e: React.PointerEvent) => {
		const eng = engineRef.current;
		if (!eng) return;
		const { u, v } = norm(e);
		if (drag.current && pose) {
			const d = drag.current;
			const w = stageSize.w || 1;
			const hfov = hfovFromAspect(d.pose.vfov, aspect);
			const dx = e.clientX - d.x;
			const dy = e.clientY - d.y;
			if (d.shift) setPose({ ...d.pose, roll: d.pose.roll + dx * 0.05 });
			else
				setPose({
					...d.pose,
					yaw: d.pose.yaw - (dx / w) * hfov,
					pitch: d.pose.pitch + (dy / stageSize.h) * d.pose.vfov,
				});
			return;
		}
		if (tool === "inspect" && settings.mode === "replace") {
			if (settings.method === "lens") update({ lens: [u, v] });
			if (pressed.current && settings.method === "swipe") update({ swipe: u });
			if (pressed.current && settings.method === "brush")
				eng.paint(u, v, 0.05, e.altKey);
		}
		// near-field objects (Step Inside scene of this pose): their own anchored position, not the terrain behind
		const obj = eng.geometryReady() ? si.sampleAt(u, v) : null;
		if (obj) {
			setHover({
				lat: obj.lat,
				lon: obj.lon,
				h: obj.elevation,
				range: obj.range,
				world: obj.enu,
				u,
				v,
				source: "object",
			});
			return;
		}
		// a lagging geometry buffer (mid-drag) would report the previous pose's terrain under the cursor
		if (
			!eng.geometryReady() ||
			(settings.protectPeople && eng.isForeground(u, v))
		) {
			setHover(null);
			return;
		}
		if (eng.sampleAtAsync) {
			// no full CPU copy of the geometry (WebGPU): one gathered texel; drop a stale answer
			const gen = ++hoverGen.current;
			void eng.sampleAtAsync(u, v).then((s) => {
				if (gen === hoverGen.current) setHover(s ? { ...s, u, v } : null);
			});
			return;
		}
		const s = eng.sampleAt(u, v);
		setHover(s ? { ...s, u, v } : null);
	};

	const onPointerUp = () => {
		drag.current = null;
		pressed.current = false;
	};

	const onWheel = (e: React.WheelEvent) => {
		if (tool !== "align" || !pose) return;
		const vfov = Math.min(
			100,
			Math.max(5, pose.vfov * (1 + e.deltaY * 0.0006)),
		);
		setPose({ ...pose, vfov });
	};

	const runAlign = (fromPrior: boolean) => {
		const eng = engineRef.current;
		// not while the load is still solving: its result would overwrite this one
		if (!eng || status) return;
		setAlignNote("Aligning…");
		const solver = unknownSolver.current;
		if (fromPrior && solver && eng.photoElement) {
			// same path as on load: never the ±25° autoAlign around a placeholder prior
			unknownAbort.current?.abort();
			const ctl = new AbortController();
			unknownAbort.current = ctl;
			resolveUnknownPose(
				photo,
				solver,
				eng.photoElement,
				eng.prior,
				eng.unknowns,
				eng.pose,
				{ signal: ctl.signal, onStage: setAlignNote },
			)
				.then((out) => {
					if (engineRef.current !== eng || ctl.signal.aborted) return;
					// an unverified guess is not saved as the user's alignment
					setPose(out.pose, out.state === "accepted");
					setAlignState(out.state);
					setAlignNote(out.note);
					return out.upgrade?.then((up) => {
						if (!up || engineRef.current !== eng || ctl.signal.aborted) return;
						setPose(up.pose);
						setAlignState(up.state);
						setAlignNote(up.note);
					});
				})
				.catch(() => {});
			return;
		}
		setTimeout(async () => {
			const res = await eng.autoAlign(fromPrior);
			if (!res || engineRef.current !== eng) return;
			setPose(res.pose);
			// a local refinement from a hand-set pose is fine, but not verified when the sensors are missing
			if (eng.unknowns.any) setAlignState("unverified");
			else setAlignState(fromPrior ? "auto" : "manual");
			setAlignNote(
				`${fromPrior ? "Auto-aligned" : "Refined"} · confidence ${(res.confidence * 100).toFixed(0)}%${eng.unknowns.any ? " · unverified" : ""}`,
			);
		}, 20);
	};

	// Apply / Revert of the eye suggestion: only ever from those buttons. Uploads persist the position in
	// their upload record (as the upload page's map pin does) with the pose; bundled photos have no
	// position store, so the move (and its pose) lasts this session.
	const applyEyeMove = async (r: EyeSearchResult) => {
		const moved = photoAtEye(photo, r);
		const persisted = await persistPosition(moved).catch(() => false);
		const prevSaved = eyeMove ? eyeMove.prevSaved : loadSavedPose(photo.id);
		if (persisted) savePose(photo.id, r.pose);
		setPins([]);
		setEyeMove({
			photo: moved,
			pose: r.pose,
			prevSaved,
			note: `Camera moved ${r.distanceM.toFixed(1)} m by the skyline eye search (unverified${persisted ? "" : ", this session only"})`,
		});
	};
	const revertEyeMove = async () => {
		if (!eyeMove) return;
		await persistPosition(photoIn).catch(() => false);
		savePose(photoIn.id, eyeMove.prevSaved);
		setPins([]);
		setEyeMove(null);
	};

	const resetExif = () => {
		const eng = engineRef.current;
		if (!eng || status) return;
		setPins([]);
		setPose(eng.prior);
		savePose(photo.id, null);
		setAlignState(eng.unknowns.any ? "unverified" : "prior");
		setAlignNote(
			eng.unknowns.any
				? "Reset to EXIF: heading/gravity/lens missing, placeholder values"
				: "Reset to phone compass + gravity",
		);
	};

	const exportImage = async () => {
		// a reveal in flight would be baked into the file: finish it first
		revealRef.current?.stop();
		const blob = await engineRef.current?.exportImage(showPeaks);
		if (!blob) return;
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${photo.id}-${settings.mode}.${blob.type === "image/png" ? "png" : "jpg"}`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 5000);
	};

	// exports need the FINAL pose: status clears after autoAlign, but a pending second opinion may still move it
	const exportLocked = !!status || !!error || verify === "pending";
	// ?concord=occl (src/lib/concord): display-only pass on the final, accepted pose; no-op without the flag
	useConcordDisplay(engineRef, {
		pose,
		settled: !exportLocked,
		verify,
		alignState,
	});

	const hfov = pose ? hfovFromAspect(pose.vfov, aspect) : 0;
	const isPhotoView = settings.mode !== "world";
	const cursor =
		settings.mode === "world"
			? "cursor-grab"
			: tool === "align"
				? "cursor-move"
				: tool === "pin"
					? pendingPeak
						? "cursor-crosshair"
						: "cursor-default"
					: settings.mode === "replace" && settings.method === "brush"
						? "cursor-cell"
						: "cursor-crosshair";

	// labels pop in as the reveal front reaches them (distance / elevation / screen position, per preset)
	const revealLabels = useMemo(() => {
		if (!revealFrame || !revealCfg.labels) return null;
		const { p, soft, fieldOf } = revealFrame;
		const w = Math.max(soft * 1.5, 0.04);
		const k = (f: number) => Math.min(1, Math.max(0, (p - f) / w));
		// easeOutBack: a little overshoot
		const pop = (x: number) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
		return {
			all: k(0.6),
			of: (l: PeakLabel) => {
				const x = k(fieldOf(l.u, l.v, l.distKm * 1000, l.ele));
				return {
					opacity: x,
					transform: `translateY(${(1 - x) * 10}px) scale(${0.55 + 0.45 * pop(x)})`,
					transformOrigin: "0 0",
				};
			},
		};
	}, [revealFrame, revealCfg.labels]);

	// the label layers re-render only when labels / layout / reveal change, not on every hover move
	const labelsSvg = useMemo(
		() => (
			<PeakLabelsSvg
				labels={placed}
				width={stageSize.w}
				height={stageSize.h}
				style={viewStyle.labels}
				subPill={labelsSubPill || undefined}
				uncertain={labelsUncertain || undefined}
				contrast={placedNeed}
			/>
		),
		[
			placedNeed,
			placed,
			stageSize.w,
			stageSize.h,
			viewStyle.labels,
			labelsSubPill,
			labelsUncertain,
		],
	);
	const classicLabels = useMemo(
		() =>
			labels.map((l) => {
				const c = classicById.get(l.name + l.world[0]);
				if (!c) return null;
				// leader: summit → block edge, a rotated gradient bar (angled when the block slid sideways)
				const ldx = c.leader[2] - c.leader[0];
				const ldy = c.leader[3] - c.leader[1];
				const len = Math.hypot(ldx, ldy);
				const deg = (Math.atan2(ldx, Math.abs(ldy)) * 180) / Math.PI;
				// terroir: prominence-class size / weight, softened guessed-pose labels (all null when off)
				const ct = peakClassOf ? classicTier(peakClassOf(l)) : null;
				const dash =
					"repeating-linear-gradient(to bottom, #000 0 3px, transparent 3px 6px)";
				// bright backdrop under the block: an extra glow on text, leader and dot (labels/contrast.ts)
				const glow = contrastFilter(
					viewStyle.labels,
					labelNeed(c.box),
					viewStyle.labels.name.px * (ct?.scale ?? 1),
				);
				return (
					<div
						key={c.id}
						className="pointer-events-none absolute"
						style={{
							left: c.x,
							top: c.y,
							...revealLabels?.of(l),
							...(labelsUncertain
								? {
										opacity: Math.min(
											revealLabels?.of(l).opacity ?? 1,
											uncertainOpacity(l.distKm),
										),
									}
								: null),
						}}
					>
						{/* sizes and colours come from style.labels via the --lbl-* variables (labelCssVars) */}
						<div
							className="absolute left-0"
							style={{
								[c.below ? "top" : "bottom"]: 0,
								height: len,
								width: "var(--lbl-lead-w)",
								transform: `translateX(-50%) rotate(${c.below ? -deg : deg}deg)`,
								transformOrigin: c.below ? "50% 0" : "50% 100%",
								backgroundImage: `linear-gradient(${c.below ? "to bottom" : "to top"} in oklab, var(--lbl-lead-from) 0%, var(--lbl-lead-to) 100%)`,
								...(labelsUncertain
									? { maskImage: dash, WebkitMaskImage: dash }
									: null),
								...(glow ? { filter: glow } : null),
							}}
						/>
						<div
							className="absolute bottom-0 left-0 -translate-x-1/2 translate-y-1/2 rounded-full"
							style={{
								width: "var(--lbl-dot)",
								height: "var(--lbl-dot)",
								backgroundColor: "var(--lbl-dot-c)",
								boxShadow: "var(--lbl-dot-shadow)",
								...(glow ? { filter: glow } : null),
							}}
						/>
						<div
							className="absolute whitespace-nowrap"
							data-peak-label={c.id}
							style={{
								left: c.anchorX - c.x,
								[c.below ? "top" : "bottom"]: c.lead,
								textAlign: c.align,
								transform:
									c.align === "center"
										? "translateX(-50%)"
										: c.align === "right"
											? "translateX(-100%)"
											: undefined,
								filter:
									glow && viewStyle.labels.halo.kind === "shadow"
										? `var(--lbl-halo) ${glow}`
										: glow || "var(--lbl-halo)",
								...(viewStyle.labels.halo.kind === "stroke"
									? {
											WebkitTextStroke: "var(--lbl-stroke)",
											paintOrder: "stroke fill",
										}
									: null),
							}}
						>
							{c.nameLines.map((t, i) => (
								<div
									key={t}
									className="leading-tight"
									style={{
										fontSize: ct
											? `calc(var(--lbl-name-px) * ${ct.scale})`
											: "var(--lbl-name-px)",
										fontWeight: ct ? ct.weight : "var(--lbl-name-w)",
										color: "var(--lbl-name-c)",
									}}
								>
									{t}
									{c.subInline && i === 0 && (
										<span
											style={{
												marginLeft: "0.3em",
												fontSize: ct
													? `calc(var(--lbl-sub-px) * ${ct.scale})`
													: "var(--lbl-sub-px)",
												fontWeight: "var(--lbl-sub-w)",
												color: "var(--lbl-sub-c)",
												...(labelsSubPill ? SUB_PILL : null),
											}}
										>
											{c.subLines[0]}
										</span>
									)}
								</div>
							))}
							{!c.subInline &&
								c.subLines.map((t) => (
									<div
										key={t}
										className="leading-tight"
										style={{
											fontSize: ct
												? `calc(var(--lbl-sub-px) * ${ct.scale})`
												: "var(--lbl-sub-px)",
											fontWeight: "var(--lbl-sub-w)",
											color: "var(--lbl-sub-c)",
											...(labelsSubPill
												? { ...SUB_PILL, margin: "0 -4px" }
												: null),
										}}
									>
										{t}
									</div>
								))}
						</div>
					</div>
				);
			}),
		[
			labels,
			classicById,
			revealLabels,
			viewStyle.labels,
			labelNeed,
			peakClassOf,
			labelsUncertain,
			labelsSubPill,
		],
	);

	const place = regionNames[photo.region] ?? photo.region;
	const taken = useMemo(() => formatTakenAt(photo), [photo]);

	return (
		<div
			className="flex h-dvh w-full flex-col bg-[#0b0f14] text-white md:flex-row"
			data-ready={status || error ? undefined : ""}
			data-renderer={rendererUsed?.renderer}
			data-renderer-reason={rendererUsed?.reason}
			data-align={alignState ?? undefined}
			data-verify={verify ?? undefined}
		>
			{/* stage */}
			<div className="relative min-h-0 flex-1">
				<header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-3 p-3">
					<Link
						to="/library"
						className="pointer-events-auto flex items-center gap-1.5 rounded-lg bg-black/50 px-2.5 py-1.5 text-xs font-medium text-white/80 ring-1 ring-white/10 backdrop-blur hover:text-white"
					>
						<ArrowLeft className="size-3.5" /> Library
					</Link>
					<div className="rounded-lg bg-black/50 px-2.5 py-1.5 text-xs text-white/70 ring-1 ring-white/10 backdrop-blur">
						<span className="font-semibold text-white">{place}</span> · {taken}{" "}
						· {photo.id}
					</div>
					<button
						type="button"
						onClick={exportImage}
						disabled={exportLocked}
						className="pointer-events-auto ml-auto flex items-center gap-1.5 rounded-lg bg-black/50 px-2.5 py-1.5 text-xs font-medium text-white/80 ring-1 ring-white/10 backdrop-blur hover:text-white disabled:opacity-40"
					>
						<Download className="size-3.5" /> Save image
					</button>
					<ExportMenu
						engine={engineRef}
						disabled={exportLocked}
						withLabels={showPeaks}
						photo={photo}
					/>
				</header>

				<div ref={stageRef} className="absolute inset-0">
					<canvas
						key={rendererFallback ? "webgl-fallback" : "primary"}
						ref={canvasRef}
						className="absolute"
						style={{
							left: stageSize.left,
							top: stageSize.top,
							width: stageSize.w,
							height: stageSize.h,
						}}
					/>
					{isPhotoView && !si.stepping && (
						<div
							className={cn("absolute touch-none select-none", cursor)}
							style={{
								left: stageSize.left,
								top: stageSize.top,
								width: stageSize.w,
								height: stageSize.h,
								...labelVars,
							}}
							onPointerDown={onPointerDown}
							onPointerMove={onPointerMove}
							onPointerUp={onPointerUp}
							onPointerLeave={() => setHover(null)}
							onWheel={onWheel}
						>
							{showPeaks &&
								tool !== "pin" &&
								viewStyle.labels.layout !== "classic" && (
									<div style={{ opacity: revealLabels ? revealLabels.all : 1 }}>
										{labelsSvg}
									</div>
								)}
							{showPeaks &&
								tool !== "pin" &&
								viewStyle.labels.layout === "classic" &&
								classicLabels}
							{tool === "pin" &&
								candidates.map((c) => {
									const active = pendingPeak?.world.join() === c.world.join();
									const pinned = pins.find(
										(p) => p.world.join() === c.world.join(),
									);
									return (
										<button
											type="button"
											key={c.name + c.world[0]}
											onPointerDown={(e) => {
												e.stopPropagation();
												setPendingPeak(active ? null : c);
											}}
											className={cn(
												"absolute -translate-x-1/2 -translate-y-1/2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap ring-1 transition",
												active
													? "z-10 bg-cyan-400 text-slate-950 ring-cyan-200"
													: pinned
														? "bg-emerald-400/90 text-slate-950 ring-emerald-200"
														: "bg-black/55 text-white/85 ring-white/25 hover:bg-black/80",
											)}
											style={{ left: `${c.u * 100}%`, top: `${c.v * 100}%` }}
										>
											{c.name}
										</button>
									);
								})}
							{tool === "pin" &&
								pins.map((p) => (
									<div
										key={`pin-${p.world.join(",")}`}
										className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-emerald-300 bg-emerald-400/40"
										style={{ left: `${p.u * 100}%`, top: `${p.v * 100}%` }}
									/>
								))}
							{hover && tool === "inspect" && (
								<div
									className="pointer-events-none absolute z-10 translate-x-3 translate-y-3 rounded-md bg-black/70 px-2 py-1 font-mono text-[10px] leading-snug text-white/90 ring-1 ring-white/10 backdrop-blur"
									style={{
										left: `${hover.u * 100}%`,
										top: `${hover.v * 100}%`,
									}}
								>
									<div>
										{hover.lat.toFixed(5)}°N {hover.lon.toFixed(5)}°E
									</div>
									<div>
										{Math.round(hover.h).toLocaleString()} m ·{" "}
										{hover.range > 1000
											? `${(hover.range / 1000).toFixed(2)} km`
											: `${Math.round(hover.range)} m`}{" "}
										away
									</div>
									{hover.source === "object" && (
										<div className="text-cyan-200" data-hover-source="object">
											object · near-field estimate
										</div>
									)}
								</div>
							)}
						</div>
					)}
					{/* terroir layers (src/lib/terroir, reports/terroir-cartography.md): renders nothing unless a
					    style.terroir switch is on (only the `terroir` preset sets any) */}
					{!si.stepping && (
						<div
							className="pointer-events-none absolute"
							data-terroir
							style={{
								left: stageSize.left,
								top: stageSize.top,
								width: stageSize.w,
								height: stageSize.h,
							}}
						>
							<TerroirLayer
								engine={engineRef.current}
								style={viewStyle}
								mode={settings.mode}
								w={stageSize.w}
								h={stageSize.h}
								uncertain={
									alignState === "unverified" || alignState === "prior"
								}
								lat={photo.lat}
								lon={photo.lon}
								takenAt={photo.takenAtUtc ?? photo.takenAt ?? null}
								stageEl={stageRef.current}
								tick={labels}
							/>
						</div>
					)}
					{/* ?picker=on (src/lib/picker): top-3 candidates + tap-a-peak; renders nothing without the flag */}
					{isPhotoView && !si.stepping && (
						<PickerMount
							engineRef={engineRef}
							photo={photo}
							pose={pose}
							alignState={alignState}
							verify={verify}
							ready={!exportLocked}
							stage={stageSize}
							unknownSolverRef={unknownSolver}
							onPreview={(p) => setPose(p, false)}
							onConfirm={(p, note) => {
								setPose(p);
								setAlignNote(note);
							}}
						/>
					)}
					{(settings.mode === "world" || si.stepping) && (
						<div className="pointer-events-none absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-2">
							<CameraModeBar si={si} />
							{settings.mode === "world" && !si.camView && (
								<div className="pointer-events-auto flex gap-2">
									{flying ? (
										<Button
											variant="solid"
											onClick={() => engineRef.current?.flyOut()}
										>
											<Plane className="size-3.5 rotate-180" /> Back out to map
										</Button>
									) : (
										<Button
											variant="accent"
											onClick={() => engineRef.current?.flyToPhoto()}
										>
											<Plane className="size-3.5" /> Fly into the photo
										</Button>
									)}
								</div>
							)}
						</div>
					)}
				</div>

				<StepInsidePanel si={si} />
				<Tiles3DCredit engineRef={engineRef} stepping={si.stepping} />

				{(verify === "verified" ||
					verify === "refined" ||
					verify === "matched") &&
					isPhotoView &&
					!status && (
						<div
							className="pointer-events-none absolute top-12 left-3 z-20"
							data-verify-badge={verify}
						>
							<div
								className={cn(
									"flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 backdrop-blur",
									verify === "verified"
										? "bg-emerald-500/20 text-emerald-200 ring-emerald-300/30"
										: "bg-cyan-500/20 text-cyan-100 ring-cyan-300/30",
								)}
								title={alignNote}
							>
								{verify === "verified" ? (
									<ShieldCheck className="size-3" />
								) : (
									<Sparkles className="size-3" />
								)}
								{verify === "verified" ? "Verified" : "Refined"}
							</div>
						</div>
					)}

				{alignState === "unverified" && isPhotoView && !status && (
					<div
						className="pointer-events-none absolute inset-x-0 top-12 z-20 flex justify-center px-3"
						data-unverified=""
					>
						<div className="flex max-w-md items-start gap-2 rounded-lg bg-amber-500/90 px-3 py-2 text-[11px] leading-snug text-slate-950 shadow-lg">
							<AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
							<span>
								<b>Unverified alignment.</b>{" "}
								{unknowns.any
									? `This photo has no ${missing} data and no solver could confirm the pose.`
									: "The skyline solvers disagree on this photo, so the pose may be a few degrees off."}{" "}
								Check the skyline, then drag, use the Heading slider or pin a
								peak.
							</span>
						</div>
					</div>
				)}

				{(status || error) && (
					<div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 backdrop-blur-sm">
						<div className="w-72 rounded-xl bg-[#121820] p-4 ring-1 ring-white/10">
							{error ? (
								<p className="text-sm text-red-300">{error}</p>
							) : (
								<>
									<p className="mb-2 text-sm text-white/80">{status?.msg}…</p>
									<div className="h-1 overflow-hidden rounded bg-white/10">
										<div
											className="h-full bg-cyan-400 transition-all"
											style={{ width: `${(status?.frac ?? 0) * 100}%` }}
										/>
									</div>
								</>
							)}
						</div>
					</div>
				)}
			</div>

			{/* panel */}
			{/* panel: mode switch (sticky) → View → Pose → Experimental & dev → credits (always shown) */}
			<aside className="flex max-h-[45dvh] w-full shrink-0 flex-col border-white/8 bg-[#10151c] md:max-h-none md:w-80 md:border-l">
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="sticky top-0 z-10 border-b border-white/8 bg-[#10151c]/95 px-4 pt-4 pb-3 backdrop-blur">
						<Segmented
							value={settings.mode}
							onChange={(mode) => {
								update({ mode });
								if (mode === "world") {
									setTool("inspect");
									revealRef.current?.stop();
								}
							}}
							options={[
								{
									value: "overlay",
									label: (
										<span className="flex items-center justify-center gap-1">
											<Layers className="size-3.5" /> Overlay
										</span>
									),
								},
								{
									value: "replace",
									label: (
										<span className="flex items-center justify-center gap-1">
											<Sparkles className="size-3.5" /> Blend
										</span>
									),
								},
								{
									value: "world",
									label: (
										<span className="flex items-center justify-center gap-1">
											<MapIcon className="size-3.5" /> In map
										</span>
									),
								},
							]}
						/>
						<p className="mt-2 text-[11px] leading-relaxed text-white/45">
							{settings.mode === "overlay" &&
								"Terrain data drawn onto the photo from the camera’s exact viewpoint."}
							{settings.mode === "replace" &&
								"Swap parts of the photo for a 3D map rendered from the same viewpoint."}
							{settings.mode === "world" &&
								"The photo projected onto 3D terrain. Orbit around, then fly into the photographer’s viewpoint."}
						</p>
					</div>

					<PanelBand label="View" hint="what is drawn and how it looks" />

					{settings.mode === "overlay" && (
						<Section title="Topology" collapse={{ id: "layers-overlay" }}>
							<Segmented
								size="sm"
								value={settings.overlayStyle}
								onChange={(overlayStyle) => update({ overlayStyle })}
								options={[
									{ value: "contours", label: "Contours" },
									{ value: "bands", label: "Bands" },
									{
										value: "slope",
										label: "Slope",
										title: "Slope angle classes: 30°, 35°, 40°, 45°",
									},
									{ value: "none", label: "None" },
								]}
							/>
							<Segmented
								size="sm"
								value={String(settings.contourInterval)}
								onChange={(v) => update({ contourInterval: Number(v) })}
								options={["20", "50", "100", "200"].map((v) => ({
									value: v,
									label: `${v} m`,
								}))}
							/>
							<Slider
								label="Layer opacity"
								value={settings.layerOpacity}
								min={0}
								max={1}
								onChange={(layerOpacity) => update({ layerOpacity })}
							/>
							<Slider
								label="Ridgelines"
								value={settings.ridges}
								min={0}
								max={1}
								onChange={(ridges) => update({ ridges })}
							/>
							<Slider
								label="Fade terrain closer than"
								value={settings.nearFade}
								min={0}
								max={400}
								step={10}
								format={(v) => (v ? `${v} m` : "off")}
								onChange={(nearFade) => update({ nearFade })}
							/>
							<Slider
								label="Distance tint"
								value={settings.depthTint}
								min={0}
								max={1}
								onChange={(depthTint) => update({ depthTint })}
							/>
							{hasPeople && (
								<Toggle
									label="Keep people in front"
									checked={settings.protectPeople}
									onChange={(protectPeople) => update({ protectPeople })}
								/>
							)}
							<Toggle
								label="Peak labels"
								checked={showPeaks}
								onChange={setShowPeaks}
							/>
							{showPeaks && <LabelStylePanel style={viewStyle} />}
							<Toggle
								label="Hiking trails"
								checked={settings.trails}
								onChange={(trails) => update({ trails })}
							/>
							{settings.trails && <TrailStylePanel style={viewStyle} />}
						</Section>
					)}

					{settings.mode === "replace" && (
						<Section title="3D map blend" collapse={{ id: "layers-replace" }}>
							<Segmented
								size="sm"
								value={settings.mapStyle}
								onChange={(mapStyle) => update({ mapStyle })}
								options={[
									{ value: "satellite", label: "Satellite" },
									{ value: "topo", label: "Topo map" },
									{ value: "hillshade", label: "Relief" },
									{ value: "bands", label: "Bands" },
								]}
							/>
							<Segmented
								size="sm"
								value={settings.method}
								onChange={(method) => {
									update({ method });
									if (method === "brush") engineRef.current?.clearBrush();
								}}
								options={[
									{ value: "lens", label: "Lens" },
									{ value: "swipe", label: "Swipe" },
									{ value: "range", label: "Distance" },
									{ value: "brush", label: "Brush" },
								]}
							/>
							{settings.method === "lens" && (
								<Slider
									label="Lens radius"
									value={settings.lensR}
									min={0.05}
									max={0.6}
									onChange={(lensR) => update({ lensR })}
								/>
							)}
							{settings.method === "swipe" && (
								<Slider
									label="Swipe position"
									value={settings.swipe}
									min={0}
									max={1}
									onChange={(swipe) => update({ swipe })}
								/>
							)}
							{settings.method === "range" && (
								<Slider
									label="Replace terrain beyond"
									value={settings.rangeKm}
									min={0.2}
									max={60}
									step={0.1}
									format={(v) => `${v.toFixed(1)} km`}
									onChange={(rangeKm) => update({ rangeKm })}
								/>
							)}
							{settings.method === "brush" && (
								<div className="flex gap-2">
									<p className="flex-1 text-[11px] leading-snug text-white/45">
										Paint to reveal the map. Hold Alt to erase.
									</p>
									<Button onClick={() => engineRef.current?.clearBrush()}>
										Clear
									</Button>
									<Button onClick={() => engineRef.current?.clearBrush(true)}>
										Fill
									</Button>
								</div>
							)}
							<Slider
								label="Feather"
								value={settings.feather}
								min={0}
								max={0.15}
								onChange={(feather) => update({ feather })}
							/>
							<Slider
								label="Ridge accent"
								value={settings.ridges}
								min={0}
								max={1}
								onChange={(ridges) => update({ ridges })}
							/>
							<Toggle
								label="Keep the photo's sky"
								checked={settings.keepSky}
								onChange={(keepSky) => update({ keepSky })}
							/>
							{hasPeople && (
								<Toggle
									label="Keep people in front"
									checked={settings.protectPeople}
									onChange={(protectPeople) => update({ protectPeople })}
								/>
							)}
							<Toggle
								label="Peak labels"
								checked={showPeaks}
								onChange={setShowPeaks}
							/>
							{showPeaks && <LabelStylePanel style={viewStyle} />}
							<Toggle
								label="Hiking trails"
								checked={settings.trails}
								onChange={(trails) => update({ trails })}
							/>
							{settings.trails && <TrailStylePanel style={viewStyle} />}
						</Section>
					)}

					{settings.mode === "world" && (
						<Section title="Photo on terrain" collapse={{ id: "layers-world" }}>
							<Segmented
								size="sm"
								value={settings.worldStyle}
								onChange={(worldStyle) => update({ worldStyle })}
								options={[
									{ value: "satellite", label: "Satellite" },
									{ value: "topo", label: "Topo map" },
									{ value: "hillshade", label: "Relief" },
								]}
							/>
							<Slider
								label="Photo projection"
								value={settings.projectOpacity}
								min={0}
								max={1}
								onChange={(projectOpacity) => update({ projectOpacity })}
							/>
							{hasPeople && (
								<Toggle
									label="Keep people in front"
									checked={settings.protectPeople}
									onChange={(protectPeople) => update({ protectPeople })}
								/>
							)}
							<Slider
								label="Skip foreground closer than"
								value={settings.minProjectRange}
								min={0}
								max={2000}
								step={10}
								format={(v) => `${Math.round(v)} m`}
								onChange={(minProjectRange) => update({ minProjectRange })}
							/>
							<Toggle
								label="Hiking trails"
								checked={settings.trails}
								onChange={(trails) => update({ trails })}
							/>
							{settings.trails && <TrailStylePanel style={viewStyle} />}
							<p className="text-[11px] leading-relaxed text-white/45">
								Drag to orbit, right-drag to pan, scroll to zoom. Only terrain
								the camera could actually see receives the photo: occluded
								slopes keep the map.
							</p>
						</Section>
					)}

					<StylePanel
						mode={settings.mode}
						settings={settings}
						style={viewStyle}
						state={styleState}
					/>

					<TerroirPanel style={viewStyle} mode={settings.mode} />

					{settings.mode !== "world" &&
						revealRef.current?.supported !== false && (
							<RevealPanel
								cfg={revealCfg}
								onChange={setRevealCfg}
								playing={!!revealFrame}
								onReplay={(c) => revealRef.current?.play(c)}
								onSeek={(c, k, first) => revealRef.current?.seek(c, k, first)}
							/>
						)}

					<PanelBand label="Pose" hint="where the camera was" />

					{isPhotoView && (
						<Section
							title="Alignment"
							collapse={{ id: "alignment" }}
							aside={
								<span className="text-[10px] text-white/35">{alignNote}</span>
							}
						>
							<Segmented
								size="sm"
								value={tool}
								onChange={(t) => {
									setTool(t);
									setPendingPeak(null);
								}}
								options={[
									{
										value: "inspect",
										label: (
											<span className="flex items-center justify-center gap-1">
												<Crosshair className="size-3" /> Inspect
											</span>
										),
									},
									{
										value: "align",
										label: (
											<span className="flex items-center justify-center gap-1">
												<Hand className="size-3" /> Drag
											</span>
										),
									},
									{
										value: "pin",
										label: (
											<span className="flex items-center justify-center gap-1">
												<MapPin className="size-3" /> Pin peaks
											</span>
										),
									},
								]}
							/>
							<p className="text-[11px] leading-relaxed text-white/45">
								{tool === "inspect" &&
									"Hover to read coordinates, elevation and distance of any pixel."}
								{tool === "align" &&
									"Drag to move the terrain. Shift-drag rolls, scroll changes field of view."}
								{tool === "pin" &&
									(pendingPeak
										? `Now click where ${pendingPeak.name} really is in the photo.`
										: "Click a peak marker, then click its true position. One pin fixes heading, two add roll, three add field of view.")}
							</p>
							<div className="flex flex-wrap gap-2">
								<Button
									variant="accent"
									onClick={() => runAlign(true)}
									disabled={!!status}
								>
									<Wand2 className="size-3.5" /> Auto-align
								</Button>
								<Button
									onClick={() => runAlign(false)}
									disabled={!!status}
									title="Local skyline refinement from the current pose"
								>
									<Mountain className="size-3.5" /> Refine
								</Button>
								<Button
									onClick={resetExif}
									disabled={!!status}
									title="Back to the phone's compass and gravity sensor"
								>
									<RotateCcw className="size-3.5" /> EXIF
								</Button>
								{pins.length > 0 && (
									<Button onClick={() => setPins([])}>
										Clear {pins.length} pins
									</Button>
								)}
							</div>
							{pose && (
								<div className="space-y-2 pt-1">
									<Slider
										label="Heading"
										value={
											unknowns.yaw ? ((pose.yaw % 360) + 360) % 360 : pose.yaw
										}
										min={unknowns.yaw ? 0 : (photo.heading ?? 0) - 40}
										max={unknowns.yaw ? 360 : (photo.heading ?? 0) + 40}
										step={0.05}
										format={(v) => `${(((v % 360) + 360) % 360).toFixed(2)}°`}
										onChange={(yaw) => setPose({ ...pose, yaw })}
									/>
									<Slider
										label="Pitch"
										value={pose.pitch}
										min={-30}
										max={30}
										step={0.05}
										format={(v) => `${v.toFixed(2)}°`}
										onChange={(pitch) => setPose({ ...pose, pitch })}
									/>
									<Slider
										label="Roll"
										value={pose.roll}
										min={-15}
										max={15}
										step={0.05}
										format={(v) => `${v.toFixed(2)}°`}
										onChange={(roll) => setPose({ ...pose, roll })}
									/>
									<Slider
										label="Field of view (h)"
										value={pose.vfov}
										min={photo.vfov * 0.7}
										max={photo.vfov * 1.3}
										step={0.02}
										format={() => `${hfov.toFixed(1)}°`}
										onChange={(vfov) => setPose({ ...pose, vfov })}
									/>
								</div>
							)}
						</Section>
					)}

					<Section
						title="Camera"
						collapse={{ id: "camera" }}
						summary={`${photo.lat.toFixed(4)}, ${photo.lon.toFixed(4)} · ${photo.f35} mm`}
					>
						<dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
							<dt className="text-white/40">Position</dt>
							<dd className="text-right font-mono text-white/75">
								{photo.lat.toFixed(5)}, {photo.lon.toFixed(5)}
							</dd>
							<dt className="text-white/40">GPS altitude</dt>
							<dd className="text-right font-mono text-white/75">
								{photoIn.alt ? `${Math.round(photoIn.alt)} m` : "—"}
							</dd>
							<dt className="text-white/40">Eye (DEM-snapped)</dt>
							<dd className="text-right font-mono text-white/75">
								{engineRef.current?.eyeAlt
									? `${Math.round(engineRef.current.eyeAlt)} m`
									: "—"}
							</dd>
							<dt className="text-white/40">Compass</dt>
							<dd className="text-right font-mono text-white/75">
								{photo.heading != null
									? `${photo.heading.toFixed(1)}°`
									: "unknown"}
							</dd>
							<dt className="text-white/40">Lens</dt>
							<dd className="text-right font-mono text-white/75">
								{photo.f35} mm eq.
							</dd>
							<dt className="text-white/40">GPS accuracy</dt>
							<dd className="text-right font-mono text-white/75">
								{photo.hAccuracy ? `±${Math.round(photo.hAccuracy)} m` : "—"}
							</dd>
						</dl>
						<EyeSuggestion
							photo={photo}
							pose={pose}
							ready={!!pose && !status && !error && verify !== "pending"}
							applied={!!eyeMove}
							onApply={applyEyeMove}
							onRevert={revertEyeMove}
						/>
					</Section>

					<PanelBand label="Advanced" tone="muted" />
					<AdvancedPanel />
				</div>
				{/* attribution is a licence requirement: pinned, never collapsed */}
				<div className="shrink-0 border-t border-white/8 px-4 py-2">
					<CreditLine
						className="text-[10px] leading-relaxed text-white/30"
						lat={photo.lat}
						lon={photo.lon}
						imagery={
							settings.mode === "replace" &&
							(settings.mapStyle === "satellite" ||
								settings.mapStyle === "topo")
								? settings.mapStyle
								: settings.mode === "world" &&
										settings.worldStyle !== "hillshade"
									? settings.worldStyle
									: "satellite"
						}
					/>
				</div>
			</aside>
		</div>
	);
}
