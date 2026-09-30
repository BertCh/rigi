// Step Inside navigation (reports/step-inside-design.md, "User-facing modes"): a camera that starts
// exactly at the solved photo camera. Four modes (setMode; keys 1–4), each eased, with an eased
// transition between them:
//
//   photo  (default) orbit / translate a little inside the scene's confidence radius about a pivot
//          `pivotDist` metres ahead of the eye (the median near-field range). State is a small offset
//          from the photo camera: orbit (yaw a, pitch b), pan (metres, ENU) and dolly (metres along the
//          photo forward). The pivot stays at the image centre while the near field shows true parallax
//          against the DEM behind it. The position is clamped to `radius` around the eye.
//   orbit  full 3D rotate about a pivot (starts on the photo pivot): unclamped yaw, pitch to straight
//          down, zoom out to the whole region; kept above the terrain.
//   fly    a free camera: mouse-look, WASD / Q E to fly (Shift = faster; speed scales with the height
//          above the ground), kept above the terrain.
//   map    top-down, north-up: drag = pan, right / shift drag or Q / E = rotate, wheel = zoom. With a
//          `mapDriver` (deck: nearfield/deck-map-camera.ts) the renderer's own map camera runs this
//          mode instead: its input, state and camera; this class only switches it on and off.
//
// The free modes share one state: a pivot, a distance from it (0 in fly: the pivot is the camera),
// heading `yaw` (rad, clockwise from north) and `pitch` (rad, up positive). Targets move with input;
// the shown state eases toward them (exponential, tau ms).
//
// Photo-mode input (on `dom`, like OrbitControls): drag = orbit, shift/right/two-finger drag = pan,
// wheel = dolly, WASD / arrows = pan / dolly, Q / E = down / up. All modes: Esc / Backspace = back to
// photo (backToPhoto: eases onto the photo camera, then onBack).
// Also exports makePhotoSky(): the photo projected on a far sphere, so the sky (and anything past the
// drape) keeps the photo's own pixels from the photo camera.
import * as THREE from "three";
import { hfovFromAspect } from "../camera";

export type StepMode = "photo" | "orbit" | "fly" | "map";
export const STEP_MODES: readonly StepMode[] = ["photo", "orbit", "fly", "map"];
/**
 * The engines' step view: 'step' is Step Inside (near-field splats, the photo's sky on a far sphere,
 * the full photo on the drape); 'map' is the In-map view driven by the same camera, in its own style.
 */
export type StepView = "step" | "map";

/** Engine.enterStepInside options (engine.ts and deck/engine.ts). */
export type StepInsideOpts = {
	radius?: number;
	pivotDist?: number;
	mode?: StepMode;
	view?: StepView;
	onBack?: () => void;
};

export type StepCameraOpts = {
	/** Photo camera position (ENU, the engine's frame). */
	eye: THREE.Vector3;
	/** Photo camera orientation (three camera convention, looking down −z). */
	quaternion: THREE.Quaternion;
	/** Photo vertical FOV (deg) and aspect (W/H): the view fits the photo frame inside the viewport. */
	vfov: number;
	aspect: number;
	/** Max distance (m) the camera may move from the eye in photo mode (NearFieldScene.confidenceRadius). */
	radius: number;
	/** Orbit pivot distance ahead of the eye (m). Default 30. */
	pivotDist?: number;
	/** Hard cap on the photo-mode orbit angles (deg). Default 45 (yaw) / 25 (pitch). */
	maxYawDeg?: number;
	maxPitchDeg?: number;
	/** Easing time constant (ms). Default 140. */
	tauMs?: number;
	/** Terrain height (ENU z, m) under ENU (x, y), or null off the DEM: keeps the free modes above ground. */
	groundAt?: (x: number, y: number) => number | null;
	/** Mode to open in (default 'photo'). */
	mode?: StepMode;
	/** Ease in from wherever the camera is now (the In-map view), instead of jumping. */
	easeIn?: boolean;
	onChange?: () => void;
	/** Called once the camera has eased back onto the photo after backToPhoto(). */
	onBack?: () => void;
	/** The renderer's own map camera for map mode (StepMapDriver). */
	mapDriver?: StepMapDriver;
};

/**
 * A renderer's own map camera for map mode (deck's MapController). While active it takes the input
 * and writes the camera; StepCamera keeps the mode switching, the transitions and keys 1–4 / Esc.
 */
export interface StepMapDriver {
	/** Take over looking straight down on `pivot` (ENU) from `dist` metres, screen-up at heading `yaw`. */
	start(pivot: THREE.Vector3, dist: number, yaw: number): void;
	/** Route input to the driver (map mode) or back to StepCamera. */
	setActive(on: boolean): void;
	/** Write the map camera (ENU position, orientation, vertical FOV). */
	apply(cam: THREE.PerspectiveCamera): void;
	/** The view centre on the ground, camera distance, heading and pitch (orbit takes over from here). */
	state(): { pivot: THREE.Vector3; dist: number; yaw: number; pitch: number };
	/** True once after the map view moved. */
	takeDirty(): boolean;
}

type State = { a: number; b: number; pan: THREE.Vector3; dolly: number };
type Free = { pivot: THREE.Vector3; dist: number; yaw: number; pitch: number };
type Transition = {
	t0: number;
	dur: number;
	pos: THREE.Vector3;
	q: THREE.Quaternion;
	fov: number;
};

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);
const X = new THREE.Vector3(1, 0, 0);
const DEG = Math.PI / 180;
/** Metres the free modes keep between the camera and the terrain. */
const CLEARANCE = 1.5;
const MAX_DIST = 150_000;
/** Vertical FOV (deg) of the free modes. */
const MODE_FOV: Record<Exclude<StepMode, "photo">, number> = {
	orbit: 55,
	fly: 60,
	map: 40,
};
const TRANSITION_MS = 750;

/** Vertical FOV (deg) that fits a photo of `vfov`/`photoAspect` inside a viewport of `viewAspect`. */
export function fitVfov(
	vfov: number,
	photoAspect: number,
	viewAspect: number,
): number {
	const forWidth = hfovFromAspect(vfov, photoAspect / viewAspect);
	return Math.max(vfov, forWidth);
}

/** Free-mode view direction for heading `yaw` (clockwise from north) and `pitch` (up positive). */
function freeForward(yaw: number, pitch: number, out: THREE.Vector3) {
	const c = Math.cos(pitch);
	return out.set(Math.sin(yaw) * c, Math.cos(yaw) * c, Math.sin(pitch));
}

/** Free-mode camera orientation: level north-looking (x +90°), pitched, then turned to `yaw`. */
function freeQuat(yaw: number, pitch: number, out: THREE.Quaternion) {
	return out
		.setFromAxisAngle(Z, -yaw)
		.multiply(_q2.setFromAxisAngle(X, Math.PI / 2 + pitch));
}

/** Heading / pitch of a camera orientation (straight down: the heading of its screen-up). */
function yawPitchOf(q: THREE.Quaternion) {
	const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
	const pitch = Math.asin(Math.max(-1, Math.min(1, f.z)));
	let yaw = Math.atan2(f.x, f.y);
	if (Math.abs(f.z) > 0.999) {
		const u = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
		yaw = Math.atan2(u.x * -Math.sign(f.z), u.y * -Math.sign(f.z));
	}
	return { yaw, pitch };
}

const cloneFree = (s: Free): Free => ({ ...s, pivot: s.pivot.clone() });
const clamp = (x: number, lo: number, hi: number) =>
	Math.max(lo, Math.min(hi, x));

export class StepCamera {
	readonly camera: THREE.PerspectiveCamera;
	readonly eye: THREE.Vector3;
	readonly baseQ: THREE.Quaternion;
	radius: number;
	pivotDist: number;
	private opts: StepCameraOpts;
	private _mode: StepMode = "photo";
	private target: State = { a: 0, b: 0, pan: new THREE.Vector3(), dolly: 0 };
	private cur: State = { a: 0, b: 0, pan: new THREE.Vector3(), dolly: 0 };
	private freeT: Free = {
		pivot: new THREE.Vector3(),
		dist: 0,
		yaw: 0,
		pitch: 0,
	};
	private freeC: Free = {
		pivot: new THREE.Vector3(),
		dist: 0,
		yaw: 0,
		pitch: 0,
	};
	private trans: Transition | null = null;
	private transE = 1;
	/** Fly keys held (w a s d q e / arrows) and Shift. */
	private keys = new Set<string>();
	private fast = false;
	private last = 0;
	private returning = false;
	private drag: { x: number; y: number; alt: boolean; id: number } | null =
		null;
	private off: (() => void)[] = [];
	private modeListeners = new Set<(m: StepMode) => void>();
	private disposed = false;

	constructor(
		camera: THREE.PerspectiveCamera,
		dom: HTMLElement | null,
		opts: StepCameraOpts,
	) {
		this.camera = camera;
		this.opts = opts;
		this.eye = opts.eye.clone();
		this.baseQ = opts.quaternion.clone();
		this.radius = Math.max(0.5, opts.radius);
		this.pivotDist = Math.max(2, opts.pivotDist ?? 30);
		if (dom) this.listen(dom);
		const m = opts.mode ?? "photo";
		if (m !== "photo") {
			// setMode starts from the camera as it is now (its transition is a no-op but for the FOV)
			this.setMode(m, "none");
		} else {
			if (opts.easeIn) this.startTransition();
			this.apply();
		}
	}

	get mode(): StepMode {
		return this._mode;
	}

	/** Subscribe to mode changes (UI buttons and keys 1–4). */
	onModeChange(cb: (m: StepMode) => void): () => void {
		this.modeListeners.add(cb);
		return () => this.modeListeners.delete(cb);
	}

	/** True when the shown camera is on the photo camera (within 1 cm / 0.01°). */
	get atPhoto(): boolean {
		const c = this.cur;
		return (
			this._mode === "photo" &&
			!this.trans &&
			Math.abs(c.a) < 2e-4 &&
			Math.abs(c.b) < 2e-4 &&
			c.pan.lengthSq() < 1e-4 &&
			Math.abs(c.dolly) < 1e-2
		);
	}

	/** Offset of the shown camera from the photo eye (m). */
	get offsetM(): number {
		return this.camera.position.distanceTo(this.eye);
	}

	/**
	 * Switch camera mode, easing from the current view. Photo mode always starts on the photo camera;
	 * orbit starts where the camera is, about the pivot ahead; fly starts where the camera is; map
	 * starts north-up over the ground ahead.
	 */
	setMode(m: StepMode, from?: StepMode | "none") {
		if (m === this._mode || this.disposed) return;
		const prev = from ?? this._mode;
		const cam = this.camera;
		const drv = this.opts.mapDriver;
		if (drv && this._mode === "map") {
			// leaving the driven map: orbit takes over from its centre and distance
			const d = drv.state();
			this.freeC = { pivot: d.pivot, dist: d.dist, yaw: d.yaw, pitch: d.pitch };
			this.freeT = cloneFree(this.freeC);
			drv.setActive(false);
		}
		this.returning = false;
		this.keys.clear();
		this.drag = null;
		this.startTransition();
		if (m === "photo") {
			this.target = { a: 0, b: 0, pan: new THREE.Vector3(), dolly: 0 };
			this.cur = { a: 0, b: 0, pan: new THREE.Vector3(), dolly: 0 };
		} else {
			const pos = cam.position.clone();
			const { yaw, pitch } = yawPitchOf(cam.quaternion);
			const fwd = freeForward(yaw, pitch, new THREE.Vector3());
			const s: Free = { pivot: pos.clone(), dist: 0, yaw, pitch };
			if (m === "orbit") {
				if (prev === "map") {
					s.pivot.copy(this.freeC.pivot);
					s.dist = this.freeC.dist;
				} else {
					// about the near-field pivot from the photo; else the terrain straight ahead
					s.dist =
						(prev === "photo" && this.opts.pivotDist
							? this.pivotDist
							: this.groundHit(pos, fwd)) ?? this.pivotDist;
					s.pivot.copy(pos).addScaledVector(fwd, s.dist);
				}
			} else if (m === "map") {
				s.yaw = 0;
				s.pitch = -Math.PI / 2;
				if (prev === "orbit") {
					s.pivot.copy(this.freeC.pivot);
					s.dist = Math.max(this.freeC.dist, 150);
				} else if (prev === "none") {
					// opened from the In-map overview: the photographer in the middle, the view around
					s.pivot.copy(this.eye);
					s.dist = 5000;
				} else {
					const h = new THREE.Vector3(Math.sin(yaw), Math.cos(yaw), 0);
					const hit = prev === "photo" ? null : this.groundHit(pos, fwd);
					if (hit != null && hit < 20_000) s.pivot.addScaledVector(fwd, hit);
					else if (prev === "photo") s.pivot.addScaledVector(h, this.pivotDist);
					const g = this.ground(pos.x, pos.y);
					const above = g == null ? 0 : pos.z - g;
					// from the photo: the near field close up; else a map-sized view of the ground ahead
					const near = prev === "photo";
					s.dist = clamp(
						Math.max(above * (near ? 2 : 1.2), this.pivotDist * 8),
						near ? 250 : 1500,
						20_000,
					);
				}
			}
			this._mode = m;
			this.clampFree(s);
			this.freeT = s;
			this.freeC = cloneFree(s);
			if (m === "map" && drv) {
				drv.start(s.pivot, s.dist, s.yaw);
				drv.setActive(true);
			}
		}
		this._mode = m;
		for (const cb of this.modeListeners) cb(m);
		this.poke();
	}

	private startTransition() {
		const cam = this.camera;
		this.trans = {
			t0: performance.now(),
			dur: TRANSITION_MS,
			pos: cam.position.clone(),
			q: cam.quaternion.clone(),
			fov: cam.fov,
		};
		this.transE = 0;
	}

	/** Distance (m) along `dir` from `from` to the terrain (coarse march), or null (sky / off the DEM). */
	private groundHit(from: THREE.Vector3, dir: THREE.Vector3): number | null {
		if (!this.opts.groundAt || dir.z > 0.2) return null;
		const p = new THREE.Vector3();
		let prev = 0;
		for (let d = 5; d < 60_000; d *= 1.08) {
			p.copy(from).addScaledVector(dir, d);
			const g = this.ground(p.x, p.y);
			if (g != null && p.z <= g) {
				// refine between the last two samples
				let lo = prev;
				let hi = d;
				for (let i = 0; i < 12; i++) {
					const mid = (lo + hi) / 2;
					p.copy(from).addScaledVector(dir, mid);
					const gm = this.ground(p.x, p.y);
					if (gm != null && p.z <= gm) hi = mid;
					else lo = mid;
				}
				return Math.max(2, hi);
			}
			prev = d;
		}
		return null;
	}

	/** Programmatic photo-mode moves (tests, UI buttons): angles in degrees, pan in ENU metres. */
	orbit(daDeg: number, dbDeg: number) {
		this.returning = false;
		this.target.a += (daDeg * Math.PI) / 180;
		this.target.b += (dbDeg * Math.PI) / 180;
		this.clampTarget();
		this.poke();
	}
	pan(dx: number, dy: number, dz = 0) {
		this.returning = false;
		// dx right, dy forward (horizontal), dz up; relative to the photo's heading
		this.basis();
		const h = _fwd.clone().setZ(0);
		if (h.lengthSq() < 1e-8) h.set(0, 1, 0);
		h.normalize();
		const r = _right.clone().setZ(0).normalize();
		this.target.pan.addScaledVector(r, dx).addScaledVector(h, dy);
		this.target.pan.z += dz;
		this.clampTarget();
		this.poke();
	}
	dollyBy(m: number) {
		this.returning = false;
		this.target.dolly += m;
		this.clampTarget();
		this.poke();
	}
	/** Jump without easing (tests). */
	snap() {
		this.cur = {
			a: this.target.a,
			b: this.target.b,
			pan: this.target.pan.clone(),
			dolly: this.target.dolly,
		};
		this.freeC = cloneFree(this.freeT);
		this.trans = null;
		this.transE = 1;
		this.apply();
	}

	/** Ease back onto the photo camera (from any mode); onBack fires when it arrives. */
	backToPhoto() {
		if (this._mode !== "photo") {
			this.setMode("photo");
			this.returning = true;
			return;
		}
		this.target = { a: 0, b: 0, pan: new THREE.Vector3(), dolly: 0 };
		this.returning = true;
		// already settled on the photo: no frame may come to finish the ease, so finish it here
		if (this.atPhoto) {
			this.cur = {
				a: 0,
				b: 0,
				pan: new THREE.Vector3(),
				dolly: 0,
			};
			this.update();
		}
		this.poke();
	}

	/**
	 * Advance the easing and write the camera. Returns true while still moving (the caller keeps
	 * rendering). Call once per rendered frame.
	 */
	update(now = performance.now()): boolean {
		const dt = this.last ? Math.min(100, now - this.last) : 16;
		this.last = now;
		const k = 1 - Math.exp(-dt / (this.opts.tauMs ?? 140));
		const flying = this._mode === "fly" && this.keys.size > 0;
		if (flying) this.flyStep(dt);
		const moving =
			this._mode === "photo"
				? this.easePhoto(k)
				: this.driven
					? !!this.opts.mapDriver?.takeDirty()
					: this.easeFree(k);
		let transiting = false;
		if (this.trans) {
			this.transE = Math.min(1, (now - this.trans.t0) / this.trans.dur);
			if (this.transE >= 1) this.trans = null;
			else transiting = true;
		}
		this.apply();
		const busy = moving || transiting || flying;
		if (!busy && this.returning && this._mode === "photo") {
			this.returning = false;
			this.last = 0;
			this.opts.onBack?.();
		}
		if (!busy) this.last = 0;
		return busy;
	}

	/** Map mode run by the renderer's map camera (opts.mapDriver). */
	private get driven() {
		return this._mode === "map" && !!this.opts.mapDriver;
	}

	private easePhoto(k: number): boolean {
		const c = this.cur;
		const t = this.target;
		c.a += (t.a - c.a) * k;
		c.b += (t.b - c.b) * k;
		c.pan.lerp(t.pan, k);
		c.dolly += (t.dolly - c.dolly) * k;
		const moving =
			Math.abs(t.a - c.a) > 1e-5 ||
			Math.abs(t.b - c.b) > 1e-5 ||
			c.pan.distanceToSquared(t.pan) > 1e-6 ||
			Math.abs(t.dolly - c.dolly) > 1e-3;
		if (!moving) {
			c.a = t.a;
			c.b = t.b;
			c.pan.copy(t.pan);
			c.dolly = t.dolly;
		}
		return moving;
	}

	private easeFree(k: number): boolean {
		const c = this.freeC;
		const t = this.freeT;
		c.yaw += (t.yaw - c.yaw) * k;
		c.pitch += (t.pitch - c.pitch) * k;
		c.pivot.lerp(t.pivot, k);
		// zoom eases in log space (a 100× zoom should not rush through the first 90 %)
		if (c.dist > 0 && t.dist > 0)
			c.dist = Math.exp(
				Math.log(c.dist) + (Math.log(t.dist) - Math.log(c.dist)) * k,
			);
		else c.dist += (t.dist - c.dist) * k;
		const tol = Math.max(1e-3, c.dist * 1e-5);
		const moving =
			Math.abs(t.yaw - c.yaw) > 1e-5 ||
			Math.abs(t.pitch - c.pitch) > 1e-5 ||
			c.pivot.distanceToSquared(t.pivot) > tol * tol ||
			Math.abs(t.dist - c.dist) > tol;
		if (!moving) this.freeC = cloneFree(t);
		return moving;
	}

	/** Fly mode: move the target by the held keys over dt ms. */
	private flyStep(dt: number) {
		const t = this.freeT;
		const k = this.keys;
		const f = freeForward(t.yaw, t.pitch, new THREE.Vector3());
		const r = new THREE.Vector3(Math.cos(t.yaw), -Math.sin(t.yaw), 0);
		const v = new THREE.Vector3()
			.addScaledVector(f, (k.has("f") ? 1 : 0) - (k.has("b") ? 1 : 0))
			.addScaledVector(r, (k.has("r") ? 1 : 0) - (k.has("l") ? 1 : 0))
			.addScaledVector(Z, (k.has("u") ? 1 : 0) - (k.has("d") ? 1 : 0));
		if (v.lengthSq() < 1e-9) return;
		v.normalize().multiplyScalar((this.flySpeed() * dt) / 1000);
		t.pivot.add(v);
		this.clampFree(t);
	}

	/** Fly speed (m/s): a fraction of the height above the ground, Shift × 4. */
	private flySpeed() {
		const p = this.camera.position;
		const g = this.ground(p.x, p.y);
		const above = g == null ? 50 : p.z - g;
		return clamp(above * 0.6, 8, 1500) * (this.fast ? 4 : 1);
	}

	private ground(x: number, y: number): number | null {
		const g = this.opts.groundAt?.(x, y);
		return g != null && Number.isFinite(g) ? g : null;
	}

	/** Mode limits: pitch range, zoom range, and (orbit / fly) the camera above the terrain. */
	private clampFree(s: Free) {
		const m = this._mode;
		if (m === "map") {
			s.pitch = -Math.PI / 2;
			s.dist = clamp(s.dist, 20, MAX_DIST);
			const g = this.ground(s.pivot.x, s.pivot.y);
			if (g != null) s.pivot.z = g;
			return;
		}
		if (m === "fly") {
			s.dist = 0;
			s.pitch = clamp(s.pitch, -89 * DEG, 89 * DEG);
			const g = this.ground(s.pivot.x, s.pivot.y);
			if (g != null) s.pivot.z = Math.max(s.pivot.z, g + CLEARANCE);
			return;
		}
		s.dist = clamp(s.dist, 2, MAX_DIST);
		s.pitch = clamp(s.pitch, -89.5 * DEG, 85 * DEG);
		// below the terrain: look down more steeply (raise the camera over the pivot)
		for (let i = 0; i < 60; i++) {
			const p = this.freePos(s, _v);
			const g = this.ground(p.x, p.y);
			if (g == null || p.z >= g + CLEARANCE) break;
			if (s.pitch <= -89 * DEG) {
				s.pivot.z += g + CLEARANCE - p.z;
				break;
			}
			s.pitch = Math.max(-89.5 * DEG, s.pitch - 1.5 * DEG);
		}
	}

	private freePos(s: Free, out: THREE.Vector3) {
		return out
			.copy(s.pivot)
			.addScaledVector(freeForward(s.yaw, s.pitch, _fwd), -s.dist);
	}

	/** Photo forward / right in ENU (the unrotated base). */
	private basis() {
		_fwd.set(0, 0, -1).applyQuaternion(this.baseQ);
		_right.set(1, 0, 0).applyQuaternion(this.baseQ);
	}

	/** Orientation for orbit angles (a about world up, b about the photo's right axis). */
	private orient(a: number, b: number, out: THREE.Quaternion) {
		this.basis();
		const yaw = new THREE.Quaternion().setFromAxisAngle(Z, -a);
		const pitch = new THREE.Quaternion().setFromAxisAngle(_right, b);
		return out.copy(yaw).multiply(pitch).multiply(this.baseQ);
	}

	private positionFor(s: State, out: THREE.Vector3) {
		this.basis();
		const pivot = _v.copy(this.eye).addScaledVector(_fwd, this.pivotDist);
		// eye relative to the pivot, rotated by the orbit (R = orient · base⁻¹)
		const rel = this.eye.clone().sub(pivot);
		const q = this.orient(s.a, s.b, _q2);
		_q.copy(this.baseQ).invert();
		rel.applyQuaternion(_q).applyQuaternion(q);
		const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
		out.copy(pivot).add(rel).add(s.pan).addScaledVector(f, s.dolly);
		// clamp inside the confidence radius
		const d = out.distanceTo(this.eye);
		if (d > this.radius)
			out
				.sub(this.eye)
				.multiplyScalar(this.radius / d)
				.add(this.eye);
		return out;
	}

	/** Keep the target reachable: orbit angles within the radius (chord ≤ radius) and the caps. */
	private clampTarget() {
		const t = this.target;
		const chord = Math.min(1, this.radius / (2 * this.pivotDist));
		const maxA = Math.min(
			((this.opts.maxYawDeg ?? 45) * Math.PI) / 180,
			2 * Math.asin(chord),
		);
		const maxB = Math.min(
			((this.opts.maxPitchDeg ?? 25) * Math.PI) / 180,
			2 * Math.asin(chord),
		);
		t.a = Math.max(-maxA, Math.min(maxA, t.a));
		t.b = Math.max(-maxB, Math.min(maxB, t.b));
		const pl = t.pan.length();
		if (pl > this.radius) t.pan.multiplyScalar(this.radius / pl);
		t.dolly = Math.max(-this.radius, Math.min(this.radius, t.dolly));
	}

	private apply() {
		const cam = this.camera;
		const m = this._mode;
		if (m === "photo") {
			this.positionFor(this.cur, cam.position);
			this.orient(this.cur.a, this.cur.b, cam.quaternion);
			cam.fov = fitVfov(this.opts.vfov, this.opts.aspect, cam.aspect || 1);
		} else if (this.driven) {
			this.opts.mapDriver?.apply(cam);
		} else {
			const s = this.freeC;
			this.freePos(s, cam.position);
			freeQuat(s.yaw, s.pitch, cam.quaternion);
			cam.fov = MODE_FOV[m];
			if (m !== "map") {
				const g = this.ground(cam.position.x, cam.position.y);
				if (g != null)
					cam.position.z = Math.max(cam.position.z, g + CLEARANCE * 0.5);
			}
		}
		const tr = this.trans;
		if (tr) {
			const t = this.transE;
			const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
			cam.position.lerpVectors(tr.pos, cam.position, e);
			cam.quaternion.slerpQuaternions(tr.q, cam.quaternion.clone(), e);
			cam.fov = tr.fov + (cam.fov - tr.fov) * e;
		}
		cam.up.set(0, 0, 1);
		cam.updateProjectionMatrix();
		cam.updateMatrixWorld(true);
	}

	private poke() {
		if (!this.disposed) this.opts.onChange?.();
	}

	/** Free-mode drag: rotate / look / pan by (dx, dy) px; `alt` = right, shift or touch-pan drag. */
	private dragFree(dx: number, dy: number, alt: boolean, h: number) {
		const t = this.freeT;
		const m = this._mode;
		const fov = this.camera.fov * DEG;
		const r = new THREE.Vector3(Math.cos(t.yaw), -Math.sin(t.yaw), 0);
		const fh = new THREE.Vector3(Math.sin(t.yaw), Math.cos(t.yaw), 0);
		if (m === "orbit" && !alt) {
			t.yaw += (dx * Math.PI) / h;
			t.pitch -= (dy * Math.PI) / h;
		} else if (m === "fly" && !alt) {
			// mouse-look: the view follows the pointer
			t.yaw += (dx * fov) / h;
			t.pitch -= (dy * fov) / h;
		} else if (m === "map" && alt) {
			t.yaw -= (dx * Math.PI) / h;
		} else {
			// grab the ground (orbit / map), strafe (fly)
			const reach =
				m === "fly" ? this.flySpeed() * 2 : t.dist * 2 * Math.tan(fov / 2);
			const mPerPx = reach / h;
			t.pivot.addScaledVector(r, -dx * mPerPx);
			if (m === "fly") t.pivot.z += dy * mPerPx;
			else t.pivot.addScaledVector(fh, dy * mPerPx);
		}
		this.clampFree(t);
		this.poke();
	}

	private wheelFree(dy: number) {
		const t = this.freeT;
		if (this._mode === "fly") {
			const f = freeForward(t.yaw, t.pitch, new THREE.Vector3());
			t.pivot.addScaledVector(f, -dy * 0.004 * this.flySpeed());
		} else t.dist *= Math.exp(dy * 0.0015);
		this.clampFree(t);
		this.poke();
	}

	/** Orbit / map keys: pan the pivot, Q / E rotate (map) or lower / raise it (orbit), +/- zoom. */
	private keyFree(key: string): boolean {
		const t = this.freeT;
		const step = Math.max(2, t.dist * 0.08);
		const r = new THREE.Vector3(Math.cos(t.yaw), -Math.sin(t.yaw), 0);
		const fh = new THREE.Vector3(Math.sin(t.yaw), Math.cos(t.yaw), 0);
		const map = this._mode === "map";
		switch (key) {
			case "ArrowLeft":
			case "a":
				t.pivot.addScaledVector(r, -step);
				break;
			case "ArrowRight":
			case "d":
				t.pivot.addScaledVector(r, step);
				break;
			case "ArrowUp":
			case "w":
				t.pivot.addScaledVector(fh, step);
				break;
			case "ArrowDown":
			case "s":
				t.pivot.addScaledVector(fh, -step);
				break;
			case "q":
				if (map) t.yaw -= 15 * DEG;
				else t.pivot.z -= step;
				break;
			case "e":
				if (map) t.yaw += 15 * DEG;
				else t.pivot.z += step;
				break;
			case "n":
				if (!map) return false;
				t.yaw = Math.round(t.yaw / (2 * Math.PI)) * 2 * Math.PI;
				break;
			case "=":
			case "+":
				t.dist /= 1.3;
				break;
			case "-":
			case "_":
				t.dist *= 1.3;
				break;
			default:
				return false;
		}
		this.clampFree(t);
		this.poke();
		return true;
	}

	private listen(dom: HTMLElement) {
		const on = <K extends keyof HTMLElementEventMap>(
			el: HTMLElement | Window,
			type: K,
			fn: (e: HTMLElementEventMap[K]) => void,
			opts?: AddEventListenerOptions,
		) => {
			el.addEventListener(type, fn as EventListener, opts);
			this.off.push(() =>
				el.removeEventListener(type, fn as EventListener, opts),
			);
		};
		on(dom, "contextmenu", (e) => e.preventDefault());
		on(dom, "pointerdown", (e) => {
			if (this.drag || this.driven) return;
			dom.setPointerCapture?.(e.pointerId);
			const touch = e.pointerType === "touch";
			this.drag = {
				x: e.clientX,
				y: e.clientY,
				// touch: photo mode pans (as before), map pans (its primary drag), orbit / fly rotate
				alt: e.shiftKey || e.button === 2 || (touch && this._mode === "photo"),
				id: e.pointerId,
			};
		});
		on(dom, "pointermove", (e) => {
			const d = this.drag;
			if (!d || d.id !== e.pointerId) return;
			const dx = e.clientX - d.x;
			const dy = e.clientY - d.y;
			d.x = e.clientX;
			d.y = e.clientY;
			const h = dom.clientHeight || 1;
			this.returning = false;
			if (this._mode !== "photo") this.dragFree(dx, dy, d.alt, h);
			else if (d.alt) {
				// one viewport height of drag ≈ the pivot's visible height at the pivot distance
				const mPerPx =
					(2 * this.pivotDist * Math.tan((this.camera.fov * Math.PI) / 360)) /
					h;
				this.pan(-dx * mPerPx, 0, dy * mPerPx);
			} else {
				const degPerPx = this.camera.fov / h;
				this.orbit(-dx * degPerPx, -dy * degPerPx);
			}
		});
		const end = (e: PointerEvent) => {
			if (this.drag?.id === e.pointerId) this.drag = null;
		};
		on(dom, "pointerup", end);
		on(dom, "pointercancel", end);
		on(
			dom,
			"wheel",
			(e) => {
				if (this.driven) return;
				e.preventDefault();
				this.returning = false;
				if (this._mode !== "photo") this.wheelFree(e.deltaY);
				else this.dollyBy(-e.deltaY * 0.002 * this.pivotDist);
			},
			{ passive: false },
		);
		const FLY_KEYS: Record<string, string> = {
			w: "f",
			ArrowUp: "f",
			s: "b",
			ArrowDown: "b",
			a: "l",
			ArrowLeft: "l",
			d: "r",
			ArrowRight: "r",
			e: "u",
			q: "d",
		};
		on(window, "keydown", (e) => {
			const el = e.target as HTMLElement | null;
			if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
			this.fast = e.shiftKey;
			const n = "1234".indexOf(key);
			if (n >= 0) {
				this.setMode(STEP_MODES[n]);
				e.preventDefault();
				return;
			}
			if (key === "Escape" || key === "Backspace") {
				this.backToPhoto();
				e.preventDefault();
				return;
			}
			// the map driver's controller has its own keys
			if (this.driven) return;
			if (this._mode === "fly") {
				const k = FLY_KEYS[key];
				if (!k) return;
				this.returning = false;
				this.keys.add(k);
				this.poke();
				e.preventDefault();
				return;
			}
			if (this._mode !== "photo") {
				this.returning = false;
				if (this.keyFree(key)) e.preventDefault();
				return;
			}
			const step = Math.max(0.5, this.radius * 0.08);
			switch (key) {
				case "ArrowLeft":
				case "a":
					this.pan(-step, 0);
					break;
				case "ArrowRight":
				case "d":
					this.pan(step, 0);
					break;
				case "ArrowUp":
				case "w":
					this.dollyBy(step);
					break;
				case "ArrowDown":
				case "s":
					this.dollyBy(-step);
					break;
				case "q":
					this.pan(0, 0, -step);
					break;
				case "e":
					this.pan(0, 0, step);
					break;
				default:
					return;
			}
			e.preventDefault();
		});
		on(window, "keyup", (e) => {
			this.fast = e.shiftKey;
			const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
			const k = FLY_KEYS[key];
			if (k) this.keys.delete(k);
		});
		on(window, "blur", () => {
			this.keys.clear();
			this.fast = false;
		});
	}

	dispose() {
		if (this.driven) this.opts.mapDriver?.setActive(false);
		this.disposed = true;
		this.keys.clear();
		this.modeListeners.clear();
		for (const f of this.off) f();
		this.off = [];
	}
}

// ---- photo sky: the photo on a far sphere, seen from the photo camera ----

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w * 0.999999; // at the far plane
}
`;
const SKY_FRAG = /* glsl */ `
uniform sampler2D uPhoto;
uniform mat4 uPhotoViewProj;
uniform vec3 uPhotoPos;
uniform vec3 uBg;
uniform float uFeather;
uniform sampler2D uSkyMask;
uniform float uSkyOn;
varying vec3 vDir;
void main() {
  vec3 dir = normalize(vDir);
  vec4 clip = uPhotoViewProj * vec4(uPhotoPos + dir * 20000.0, 1.0);
  vec3 col = uBg;
  if (clip.w > 0.0) {
    vec2 puv = clip.xy / clip.w * 0.5 + 0.5;
    vec2 e = min(puv, 1.0 - puv);
    float inside = smoothstep(-uFeather, 0.0, min(e.x, e.y));
    // only the photo's sky: foreground pixels belong to the drape / splats, not to a far sphere
    if (uSkyOn > 0.5) inside *= texture2D(uSkyMask, clamp(puv, 0.0, 1.0)).r;
    if (inside > 0.0) {
      vec3 pc = texture2D(uPhoto, clamp(puv, 0.0, 1.0)).rgb;
      col = mix(uBg, pc, inside);
    }
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

export type PhotoSky = THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;

/**
 * A camera-centred sphere textured with the photo projected from the photo camera (outside the frame:
 * `bg`, feathered). Draw it first (renderOrder −1e9, no depth); keep it centred on the viewing camera.
 * The uniforms uPhoto / uPhotoViewProj / uPhotoPos are the engine's drape uniforms' values.
 */
export function makePhotoSky(radius = 100_000): PhotoSky {
	const m = new THREE.Mesh(
		new THREE.SphereGeometry(radius, 48, 24),
		new THREE.ShaderMaterial({
			vertexShader: SKY_VERT,
			fragmentShader: SKY_FRAG,
			uniforms: {
				uPhoto: { value: null },
				uPhotoViewProj: { value: new THREE.Matrix4() },
				uPhotoPos: { value: new THREE.Vector3() },
				uBg: { value: new THREE.Color(0x0b0f14) },
				uFeather: { value: 0.02 },
				uSkyMask: { value: null },
				uSkyOn: { value: 0 },
			},
			side: THREE.BackSide,
			depthTest: false,
			depthWrite: false,
		}),
	);
	m.name = "PhotoSky";
	m.frustumCulled = false;
	m.renderOrder = -1e9;
	return m;
}
