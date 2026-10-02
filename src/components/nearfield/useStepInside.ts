// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside state for PhotoWorkspace: one NearFieldController per engine, the accepted-pose gate, the
// step camera enter / back, the Truth toggle and the hover sampler. Everything stays dormant (and the
// panel invisible) while the near-field service is down or the engine has no setNearField.

import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { Pose } from "#/lib/camera";
import { getFlag } from "#/lib/flags";
import { useFlag } from "#/lib/flags/react";
import {
	NearFieldController,
	type NearFieldState,
	poseAccepted,
} from "#/lib/nearfield/controller";
import { median } from "#/lib/nearfield/geom";
import type { MeasurableScene, NearFieldSample } from "#/lib/nearfield/measure";
import type {
	StepCamera,
	StepInsideOpts,
	StepMode,
	StepView,
} from "#/lib/nearfield/step-camera";
import type { PhotoMeta } from "#/lib/photos";
import type { Renderer } from "#/lib/renderer";

/** The engine extras Step Inside drives (structural: the deck engines have them). */
type StepEngine = Renderer & {
	enterStepInside?(o: StepInsideOpts): void;
	exitStepInside?(): void;
	readonly stepCamera?: StepCamera | null;
	readonly steppingInside?: boolean;
	readonly nearFieldInfo?: unknown;
};

export type StepInside = {
	/** Service up and engine capable: show the panel at all. */
	visible: boolean;
	state: NearFieldState;
	accepted: boolean;
	/** Why the button is disabled, or null when it can be pressed. */
	disabledReason: string | null;
	stepping: boolean;
	/** The step camera drives the view: 'step' (Step Inside) or 'map' (In map), else null. */
	camView: StepView | null;
	/** Current camera mode ('orbit' in the In-map view before the step camera takes over). */
	camMode: StepMode;
	/** Camera mode bar allowed (not under automation unless opted in). */
	camModesAllowed: boolean;
	/**
	 * Switch camera mode. While stepping: the step camera's setMode. In the In-map view: hands the
	 * world camera to a step camera (view 'map') in that mode.
	 */
	setCamMode: (m: StepMode) => void;
	truth: boolean;
	setTruth: (v: boolean) => void;
	enter: () => void;
	back: () => void;
	/** Hover readout on near-field Object pixels (current pose's scene only). */
	sampleAt: (u: number, v: number) => NearFieldSample | null;
};

/** The camera-mode bar: like stepInsideAllowed, plus ?cammodes=on opts automation in without the service. */
export function camModesAllowed(): boolean {
	if (typeof window === "undefined") return false;
	return stepInsideAllowed() || getFlag("cammodes") === "on";
}

/**
 * Whether the Step Inside UI may probe the service at all (?nearfield, src/lib/flags). "auto" (the
 * default) probes except in automated browsers (navigator.webdriver: style-baseline, eval-app,
 * leaderboards), so their captures and network stay as they were (the reveal's precedent,
 * src/lib/reveal/config.ts); they opt in with ?nearfield=on or =sharp. ?nearfield=off hides it for everyone.
 */
export function stepInsideAllowed(): boolean {
	if (typeof window === "undefined") return false;
	const m = getFlag("nearfield");
	if (m === "off") return false;
	return m !== "auto" || !navigator.webdriver;
}

/** Median range (m) of the scene's measured Object cells: the step camera's orbit pivot. */
function pivotFor(scene: MeasurableScene): number | undefined {
	const r = scene.measure?.range;
	if (!r) return undefined;
	const a: number[] = [];
	for (let i = 0; i < r.length; i++) if (r[i] > 0) a.push(r[i]);
	const m = median(a);
	return Number.isFinite(m) ? Math.min(Math.max(m, 3), 300) : undefined;
}

export function useStepInside(opts: {
	engineRef: RefObject<Renderer | null>;
	/** The engine finished loading (no status / error). */
	ready: boolean;
	photo: PhotoMeta;
	pose: Pose | null;
	alignState: string | null;
	verify: string | null;
	/** The workspace is in the In-map (world) view. */
	worldMode?: boolean;
}): StepInside {
	const { engineRef, ready, photo, pose, alignState, verify, worldMode } = opts;
	// ?cammodes applies live: re-render when it changes (camModesAllowed reads it)
	useFlag("cammodes");
	const ctlRef = useRef<NearFieldController | null>(null);
	const [ctl, setCtl] = useState<NearFieldController | null>(null);
	const [state, setState] = useState<NearFieldState>({ phase: "idle" });
	const [available, setAvailable] = useState(false);
	const [stepping, setStepping] = useState(false);
	const [camView, setCamView] = useState<StepView | null>(null);
	const [camMode, setCamModeState] = useState<StepMode>("photo");
	const camOffRef = useRef<(() => void) | null>(null);
	/** The step camera left (onBack, exit, pose / view change): back to the idle state. */
	const camGone = useCallback(() => {
		camOffRef.current?.();
		camOffRef.current = null;
		setStepping(false);
		setCamView(null);
		setCamModeState("photo");
	}, []);
	/** Follow the engine's new step camera (its mode changes too: keys 1–4). */
	const camEntered = useCallback((engine: StepEngine, view: StepView) => {
		camOffRef.current?.();
		const cam = engine.stepCamera;
		camOffRef.current = cam?.onModeChange(setCamModeState) ?? null;
		setCamModeState(cam?.mode ?? "photo");
		setCamView(view);
		setStepping(view === "step");
	}, []);
	const [truth, setTruthState] = useState(false);
	const truthRef = useRef(truth);
	truthRef.current = truth;
	const accepted = poseAccepted(alignState, verify);
	const acceptedRef = useRef(accepted);
	acceptedRef.current = accepted;

	// one controller per loaded engine
	useEffect(() => {
		const engine = engineRef.current;
		if (!ready || !engine?.setNearField || !stepInsideAllowed()) return;
		const c = new NearFieldController(engine, photo);
		ctlRef.current = c;
		setCtl(c);
		const off = c.onState(setState);
		let live = true;
		c.available().then((ok) => live && setAvailable(ok));
		// the service may come up later: re-check now and then (the client caches health 15 s when down)
		const t = window.setInterval(
			() => c.available().then((ok) => live && setAvailable(ok)),
			20_000,
		);
		return () => {
			live = false;
			window.clearInterval(t);
			off();
			(engine as StepEngine).exitStepInside?.();
			c.dispose();
			if (ctlRef.current === c) ctlRef.current = null;
			setCtl(null);
			camGone();
			setState({ phase: "idle" });
		};
	}, [ready, engineRef, photo, camGone]);

	// the engine leaves the step camera on a view switch (overlay / blend / In map): follow it
	useEffect(() => {
		void worldMode;
		const t = window.setTimeout(() => {
			const engine = engineRef.current as StepEngine | null;
			if (!engine?.steppingInside) camGone();
		}, 0);
		return () => window.clearTimeout(t);
	}, [worldMode, engineRef, camGone]);

	// a pose change makes the scene stale: leave the step camera, drop the splats, and (when the slow
	// service part is cached and the pose is still accepted) rebuild locally after the pose settles
	const poseSig = pose
		? `${pose.yaw}|${pose.pitch}|${pose.roll}|${pose.vfov}`
		: "";
	const poseSigRef = useRef(poseSig);
	poseSigRef.current = poseSig;
	useEffect(() => {
		const c = ctlRef.current;
		if (!c || !poseSig) return;
		const engine = engineRef.current as StepEngine | null;
		if (engine?.steppingInside) {
			engine.exitStepInside?.();
			camGone();
		}
		c.invalidate();
		if (!c.hasPhotoData()) return;
		const t = window.setTimeout(() => {
			if (acceptedRef.current) void c.build();
		}, 400);
		return () => window.clearTimeout(t);
	}, [poseSig, engineRef, camGone]);

	const setTruth = useCallback((v: boolean) => {
		setTruthState(v);
		ctlRef.current?.setViewOpts({ truth: v });
	}, []);

	const back = useCallback(() => {
		const engine = engineRef.current as StepEngine | null;
		const cam = engine?.stepCamera;
		if (cam && !cam.atPhoto) cam.backToPhoto();
		else {
			engine?.exitStepInside?.();
			camGone();
		}
	}, [engineRef, camGone]);

	const enter = useCallback(() => {
		const c = ctlRef.current;
		const engine = engineRef.current as StepEngine | null;
		if (!c || !engine?.enterStepInside || !acceptedRef.current) return;
		const sig0 = poseSigRef.current;
		void (async () => {
			const scene = await c.build();
			if (!scene || ctlRef.current !== c || engineRef.current !== engine)
				return;
			// the build takes 10-60 s: the pose may have changed (auto-align) or lost its accepted state
			if (!acceptedRef.current || poseSigRef.current !== sig0) return;
			c.show({ truth: truthRef.current, maskDrape: true });
			engine.enterStepInside?.({
				radius: scene.confidenceRadius,
				pivotDist: pivotFor(scene),
				onBack: () => {
					engine.exitStepInside?.();
					camGone();
				},
			});
			camEntered(engine, "step");
		})();
	}, [engineRef, camGone, camEntered]);

	const setCamMode = useCallback(
		(m: StepMode) => {
			const engine = engineRef.current as StepEngine | null;
			if (!engine) return;
			const cam = engine.stepCamera;
			if (cam) {
				cam.setMode(m);
				return;
			}
			// In map: OrbitControls is the native 'orbit'; any other mode hands over to a step camera
			if (!worldMode || m === "orbit" || !engine.enterStepInside) return;
			engine.enterStepInside({
				view: "map",
				mode: m,
				onBack: () => {
					engine.exitStepInside?.();
					camGone();
				},
			});
			camEntered(engine, "map");
		},
		[engineRef, worldMode, camGone, camEntered],
	);

	const sampleAt = useCallback(
		(u: number, v: number) => ctlRef.current?.sampleAt(u, v) ?? null,
		[],
	);

	// dev handle (like window.__engine): state, build / enter / back and the step camera
	useEffect(() => {
		if (!import.meta.env.DEV || !ctl) return;
		const w = window;
		const handle = {
			controller: ctl,
			get state() {
				return ctl.state;
			},
			get accepted() {
				return acceptedRef.current;
			},
			get info() {
				return (engineRef.current as StepEngine | null)?.nearFieldInfo ?? null;
			},
			get step() {
				return (engineRef.current as StepEngine | null)?.stepCamera ?? null;
			},
			available: (force = true) => ctl.available(force),
			build: () => ctl.build(),
			show: (o = {}) => ctl.show(o),
			hide: () => ctl.hide(),
			enter,
			back,
			setTruth,
			setCamMode,
			sampleAt: (u: number, v: number) => ctl.sampleAt(u, v),
		};
		w.__nearfield = handle;
		return () => {
			if (w.__nearfield === handle) w.__nearfield = undefined;
		};
	}, [ctl, enter, back, setTruth, setCamMode, engineRef]);

	const phase = state.phase;
	const disabledReason = !accepted
		? "Needs an accepted pose: auto-align must be verified, or pin / save the alignment"
		: phase === "loading"
			? (state.message ?? "Working")
			: phase === "low-quality"
				? (state.message ?? "Terrain anchoring too weak for this photo")
				: phase === "error"
					? null // retry allowed
					: null;

	return {
		// a built scene (or the step camera) needs no service: keep the panel, and its Back button, when a
		// health probe fails mid-session
		visible:
			!!ctl &&
			(stepping ||
				phase === "ready" ||
				phase === "low-quality" ||
				(available && phase !== "unavailable")),
		state,
		accepted,
		disabledReason,
		stepping,
		camView,
		camMode: camView ? camMode : worldMode ? "orbit" : "photo",
		camModesAllowed: camModesAllowed(),
		setCamMode,
		truth,
		setTruth,
		enter,
		back,
		sampleAt,
	};
}
