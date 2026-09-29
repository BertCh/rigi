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
import {
	NearFieldController,
	type NearFieldState,
	poseAccepted,
} from "#/lib/nearfield/controller";
import { median } from "#/lib/nearfield/geom";
import type { MeasurableScene, NearFieldSample } from "#/lib/nearfield/measure";
import type { StepCamera } from "#/lib/nearfield/step-camera";
import type { PhotoMeta } from "#/lib/photos";
import type { Renderer } from "#/lib/renderer";

/** The engine extras Step Inside drives (structural: PhotoEngine and DeckEngine both have them). */
type StepEngine = Renderer & {
	enterStepInside?(o: {
		radius?: number;
		pivotDist?: number;
		onBack?: () => void;
	}): void;
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
	truth: boolean;
	setTruth: (v: boolean) => void;
	enter: () => void;
	back: () => void;
	/** Hover readout on near-field Object pixels (current pose's scene only). */
	sampleAt: (u: number, v: number) => NearFieldSample | null;
};

/**
 * Whether the Step Inside UI may probe the service at all. Automated browsers (navigator.webdriver:
 * style-baseline, eval-app, leaderboards) never see it unless they opt in with ?nearfield (any value,
 * e.g. ?nearfield=1 or ?nearfield=sharp), so their captures and network stay exactly as before
 * (the reveal's precedent, src/lib/reveal/config.ts). ?nearfield=off hides it for everyone.
 */
export function stepInsideAllowed(): boolean {
	if (typeof window === "undefined") return false;
	const q = new URLSearchParams(window.location.search).get("nearfield");
	if (q === "off" || q === "0") return false;
	return q != null || !navigator.webdriver;
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
}): StepInside {
	const { engineRef, ready, photo, pose, alignState, verify } = opts;
	const ctlRef = useRef<NearFieldController | null>(null);
	const [ctl, setCtl] = useState<NearFieldController | null>(null);
	const [state, setState] = useState<NearFieldState>({ phase: "idle" });
	const [available, setAvailable] = useState(false);
	const [stepping, setStepping] = useState(false);
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
			setStepping(false);
			setState({ phase: "idle" });
		};
	}, [ready, engineRef, photo]);

	// a pose change makes the scene stale: leave the step camera, drop the splats, and (when the slow
	// service part is cached and the pose is still accepted) rebuild locally after the pose settles
	const poseSig = pose
		? `${pose.yaw}|${pose.pitch}|${pose.roll}|${pose.vfov}`
		: "";
	useEffect(() => {
		const c = ctlRef.current;
		if (!c || !poseSig) return;
		const engine = engineRef.current as StepEngine | null;
		if (engine?.steppingInside) {
			engine.exitStepInside?.();
			setStepping(false);
		}
		c.invalidate();
		if (!c.hasPhotoData()) return;
		const t = window.setTimeout(() => {
			if (acceptedRef.current) void c.build();
		}, 400);
		return () => window.clearTimeout(t);
	}, [poseSig, engineRef]);

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
			setStepping(false);
		}
	}, [engineRef]);

	const enter = useCallback(() => {
		const c = ctlRef.current;
		const engine = engineRef.current as StepEngine | null;
		if (!c || !engine?.enterStepInside || !acceptedRef.current) return;
		void (async () => {
			const scene = await c.build();
			if (!scene || ctlRef.current !== c || engineRef.current !== engine)
				return;
			c.show({ truth: truthRef.current, maskDrape: true });
			engine.enterStepInside?.({
				radius: scene.confidenceRadius,
				pivotDist: pivotFor(scene),
				onBack: () => {
					engine.exitStepInside?.();
					setStepping(false);
				},
			});
			setStepping(true);
		})();
	}, [engineRef]);

	const sampleAt = useCallback(
		(u: number, v: number) => ctlRef.current?.sampleAt(u, v) ?? null,
		[],
	);

	// dev handle (like window.__engine): state, build / enter / back and the step camera
	useEffect(() => {
		if (!import.meta.env.DEV || !ctl) return;
		const w = window as unknown as { __nearfield?: unknown };
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
			sampleAt: (u: number, v: number) => ctl.sampleAt(u, v),
		};
		w.__nearfield = handle;
		return () => {
			if (w.__nearfield === handle) w.__nearfield = undefined;
		};
	}, [ctl, enter, back, setTruth, engineRef]);

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
		visible: !!ctl && available && phase !== "unavailable",
		state,
		accepted,
		disabledReason,
		stepping,
		truth,
		setTruth,
		enter,
		back,
		sampleAt,
	};
}
