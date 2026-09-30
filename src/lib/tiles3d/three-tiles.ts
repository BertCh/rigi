// engine.ts's side of Step Inside 3D Tiles: owns the photo's Tiles3DSet, shows it only while stepping,
// feeds it the step camera and the drape's uniforms, and hides display-only (Google) content for
// exports. engine.ts calls: enter/exit (enterStepInside/exitStepInside), beforeRender (renderWorld),
// withoutDisplayOnly (exportImage), dispose.
import type * as THREE from "three";
import {
	PROVENANCE_COLORS,
	PROVENANCE_TINT_MIX,
} from "../nearfield/provenance";
import { type Tiles3DConfig, tiles3dConfig } from "./config";
import type { TileSharedUniforms } from "./material";
import { Tiles3DSet } from "./tiles";

type DrapeUniforms = Pick<
	TileSharedUniforms,
	"uPhotoViewProj" | "uPhotoPos" | "uPhotoRange" | "uPhotoFg" | "uPhotoFgOn"
>;

export class ThreeTiles3D {
	private set: Tiles3DSet | null = null;
	private active = false;
	private hidden = false;

	private constructor(
		private config: Tiles3DConfig,
		private scene: THREE.Scene,
		private drape: DrapeUniforms,
		private requestRender: () => void,
	) {}

	/** null when ?tiles3d is off (the default): engine.ts then never touches tiles. */
	static create(
		scene: THREE.Scene,
		drape: DrapeUniforms,
		requestRender: () => void,
	): ThreeTiles3D | null {
		const config = tiles3dConfig();
		return config
			? new ThreeTiles3D(config, scene, drape, requestRender)
			: null;
	}

	/** Stepping starts: make the photo's set on first use (eye in ENU metres). */
	enter(lat: number, lon: number, eye: THREE.Vector3) {
		if (!this.set) {
			this.set = new Tiles3DSet(this.config, { lat, lon, eye }, this.drape);
			this.set.onChange = () => {
				if (this.active) this.requestRender();
			};
			console.info(
				`[tiles3d] ${this.config.sources.join(", ")} · blend ${this.config.blend} · geoid N ${this.set.geoidN.toFixed(2)} m`,
			);
			this.scene.add(this.set.group);
		}
		this.set.uniforms.uEye.value.copy(eye);
		this.active = true;
		this.set.group.visible = true;
		this.requestRender();
	}

	exit() {
		this.active = false;
		if (this.set) this.set.group.visible = false;
	}

	/** Each step frame, before renderer.render(scene, worldCam). */
	beforeRender(
		worldCam: THREE.PerspectiveCamera,
		width: number,
		height: number,
		opts: { truth: boolean },
	) {
		const set = this.set;
		if (!set || !this.active) return;
		const u = set.uniforms;
		u.uFill.value = this.config.blend === "fill" && u.uPhotoRange.value ? 1 : 0;
		// Truth: survey models (swisstopo) tint as DEM-grade truth; Google is not ours to label: hidden
		u.uTruth.value = opts.truth ? PROVENANCE_TINT_MIX : 0;
		const d = PROVENANCE_COLORS.dem;
		u.uTruthColor.value.setRGB(d[0] / 255, d[1] / 255, d[2] / 255);
		set.setSourceVisible("google", !opts.truth && !this.hidden);
		set.update(worldCam, width, height);
	}

	/** Run `capture` with display-only (Google) tiles hidden: they never enter an export. */
	async withoutDisplayOnly<T>(capture: () => T | Promise<T>): Promise<T> {
		if (!this.set?.hasGoogle) return capture();
		this.hidden = true;
		this.set.setSourceVisible("google", false);
		try {
			return await capture();
		} finally {
			this.hidden = false;
			this.requestRender();
		}
	}

	/** The on-screen credit line while stepping, or null. */
	attribution(): string | null {
		return this.active && this.set ? this.set.attributions() : null;
	}

	get tiles(): Tiles3DSet | null {
		return this.set;
	}

	dispose() {
		this.set?.dispose();
		this.set = null;
		this.active = false;
	}
}
