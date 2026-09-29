// Step Inside navigation (reports/step-inside-design.md, "User-facing modes"): a camera that starts
// exactly at the solved photo camera and lets the user orbit / translate a little inside the scene's
// confidence radius, eased and clamped, then glide back to the photo.
//
// State is a small offset from the photo camera:
//   orbit (yaw a, pitch b) about a pivot `pivotDist` metres ahead of the eye (the median near-field
//   range), pan (metres, ENU) and dolly (metres along the photo forward). The camera orientation is the
//   photo orientation rotated by the same orbit angles, so the pivot stays at the image centre while the
//   near field shows true parallax against the DEM behind it. The position is clamped to `radius`
//   around the eye. Targets move with input; the shown state eases toward them (exponential, tau ms).
//
// Input (on `dom`, like OrbitControls): drag = orbit, shift/right/two-finger drag = pan, wheel = dolly,
// WASD / arrows = pan / dolly, Q / E = down / up, Esc / Backspace = back to photo.
// Also exports makePhotoSky(): the photo projected on a far sphere, so the sky (and anything past the
// drape) keeps the photo's own pixels from the photo camera.
import * as THREE from "three";

export type StepCameraOpts = {
	/** Photo camera position (ENU, the engine's frame). */
	eye: THREE.Vector3;
	/** Photo camera orientation (three camera convention, looking down −z). */
	quaternion: THREE.Quaternion;
	/** Photo vertical FOV (deg) and aspect (W/H): the view fits the photo frame inside the viewport. */
	vfov: number;
	aspect: number;
	/** Max distance (m) the camera may move from the eye (NearFieldScene.confidenceRadius). */
	radius: number;
	/** Orbit pivot distance ahead of the eye (m). Default 30. */
	pivotDist?: number;
	/** Hard cap on the orbit angles (deg). Default 45 (yaw) / 25 (pitch). */
	maxYawDeg?: number;
	maxPitchDeg?: number;
	/** Easing time constant (ms). Default 140. */
	tauMs?: number;
	onChange?: () => void;
	/** Called once the camera has eased back onto the photo after backToPhoto(). */
	onBack?: () => void;
};

type State = { a: number; b: number; pan: THREE.Vector3; dolly: number };

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

/** Vertical FOV (deg) that fits a photo of `vfov`/`photoAspect` inside a viewport of `viewAspect`. */
export function fitVfov(
	vfov: number,
	photoAspect: number,
	viewAspect: number,
): number {
	const t = Math.tan((vfov * Math.PI) / 360);
	const forWidth =
		(2 * Math.atan(t * (photoAspect / viewAspect)) * 180) / Math.PI;
	return Math.max(vfov, forWidth);
}

export class StepCamera {
	readonly camera: THREE.PerspectiveCamera;
	readonly eye: THREE.Vector3;
	readonly baseQ: THREE.Quaternion;
	radius: number;
	pivotDist: number;
	private opts: StepCameraOpts;
	private target: State = { a: 0, b: 0, pan: new THREE.Vector3(), dolly: 0 };
	private cur: State = { a: 0, b: 0, pan: new THREE.Vector3(), dolly: 0 };
	private last = 0;
	private returning = false;
	private drag: { x: number; y: number; pan: boolean; id: number } | null =
		null;
	private off: (() => void)[] = [];
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
		this.apply();
	}

	/** True when the shown camera is on the photo camera (within 1 cm / 0.01°). */
	get atPhoto(): boolean {
		const c = this.cur;
		return (
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

	/** Programmatic moves (tests, UI buttons): angles in degrees, pan in ENU metres. */
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
		this.apply();
	}

	/** Ease back onto the photo camera; onBack fires when it arrives. */
	backToPhoto() {
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
		this.apply();
		if (!moving && this.returning) {
			this.returning = false;
			this.last = 0;
			this.opts.onBack?.();
		}
		if (!moving) this.last = 0;
		return moving;
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
		this.positionFor(this.cur, cam.position);
		this.orient(this.cur.a, this.cur.b, cam.quaternion);
		cam.up.set(0, 0, 1);
		cam.fov = fitVfov(this.opts.vfov, this.opts.aspect, cam.aspect || 1);
		cam.updateProjectionMatrix();
		cam.updateMatrixWorld(true);
	}

	private poke() {
		if (!this.disposed) this.opts.onChange?.();
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
			if (this.drag) return;
			dom.setPointerCapture?.(e.pointerId);
			this.drag = {
				x: e.clientX,
				y: e.clientY,
				pan: e.shiftKey || e.button === 2 || e.pointerType === "touch",
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
			if (d.pan) {
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
				e.preventDefault();
				this.dollyBy(-e.deltaY * 0.002 * this.pivotDist);
			},
			{ passive: false },
		);
		on(window, "keydown", (e) => {
			const el = e.target as HTMLElement | null;
			if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
			const step = Math.max(0.5, this.radius * 0.08);
			switch (e.key) {
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
				case "Escape":
				case "Backspace":
					this.backToPhoto();
					break;
				default:
					return;
			}
			e.preventDefault();
		});
	}

	dispose() {
		this.disposed = true;
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
