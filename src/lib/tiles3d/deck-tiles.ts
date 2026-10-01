// deck/engine.ts's side of Step Inside 3D Tiles: owns the photo's Tiles3DSet,
// refines it from the deck world camera (a THREE camera) while stepping and hands worldLayers() a
// Tiles3DDeckLayer. Tile arrivals are coalesced to one layer update per animation frame. The tiles
// renderer and its layer are imported only once ?tiles3d= is on; an enter() before
// they arrive is replayed on arrival.
import type * as THREE from "three";
import type { PhotoRangeMap } from "../deck/terrain-layer";
import {
	PROVENANCE_COLORS,
	PROVENANCE_TINT_MIX,
} from "../nearfield/provenance";
import { type Tiles3DConfig, tiles3dConfig } from "./config";
import type { Tiles3DDeckLayer } from "./deck-layer";
import type { Tiles3DSet } from "./tiles";

type Mods = [typeof import("./tiles"), typeof import("./deck-layer")];

export class DeckTiles3D {
	private set: Tiles3DSet | null = null;
	private active = false;
	private hidden = false;
	private raf = 0;
	private mods: Mods | null = null;
	private pending: { lat: number; lon: number; eye: THREE.Vector3 } | null =
		null;
	private disposed = false;

	private constructor(
		private config: Tiles3DConfig,
		private onChange: () => void,
	) {}

	/** null when ?tiles3d is off (the default): deck/engine.ts then never touches tiles. */
	static create(onChange: () => void): DeckTiles3D | null {
		const config = tiles3dConfig();
		if (!config) return null;
		const t = new DeckTiles3D(config, onChange);
		void Promise.all([import("./tiles"), import("./deck-layer")]).then((m) => {
			if (t.disposed) return;
			t.mods = m;
			const p = t.pending;
			t.pending = null;
			if (p) {
				t.enter(p.lat, p.lon, p.eye);
				t.onChange();
			}
		});
		return t;
	}

	enter(lat: number, lon: number, eye: THREE.Vector3) {
		if (!this.mods) {
			this.pending = { lat, lon, eye };
			return;
		}
		if (!this.set) {
			this.set = new this.mods[0].Tiles3DSet(this.config, { lat, lon, eye });
			this.set.onChange = () => {
				if (!this.active || this.raf) return;
				this.raf = requestAnimationFrame(() => {
					this.raf = 0;
					if (this.active) this.onChange();
				});
			};
			console.info(
				`[tiles3d] ${this.config.sources.join(", ")} · blend ${this.config.blend} · geoid N ${this.set.geoidN.toFixed(2)} m (deck)`,
			);
		}
		this.set.uniforms.uEye.value.copy(eye);
		this.active = true;
	}

	exit() {
		this.pending = null;
		this.active = false;
	}

	/** Each stepping world frame: refine from the world camera. */
	update(cam: THREE.PerspectiveCamera, width: number, height: number) {
		if (this.active) this.set?.update(cam, width, height);
	}

	/** The tiles layer for worldLayers() (opaque: before the splats), or null. */
	layer(p: {
		photoViewProj: number[];
		photoPos: [number, number, number];
		photoRange: PhotoRangeMap | null;
		photoFg: { width: number; height: number; data: Uint8Array } | null;
		truth: boolean;
		camera: THREE.Vector3;
	}): Tiles3DDeckLayer | null {
		const set = this.set;
		if (!set || !this.active || !this.mods) return null;
		const d = PROVENANCE_COLORS.dem;
		return new this.mods[1].Tiles3DDeckLayer({
			id: "world-tiles3d",
			set,
			version: set.version,
			fill: this.config.blend === "fill",
			photoViewProj: p.photoViewProj,
			photoPos: p.photoPos,
			photoRange: p.photoRange,
			photoFg: p.photoFg,
			truth: p.truth ? PROVENANCE_TINT_MIX : 0,
			truthColor: [d[0] / 255, d[1] / 255, d[2] / 255],
			// Truth view: Google is not ours to label; exports never carry it
			hideDisplayOnly: p.truth || this.hidden,
			camera: [p.camera.x, p.camera.y, p.camera.z],
		});
	}

	/** Run `capture` with display-only (Google) tiles hidden (the caller re-renders inside it). */
	async withoutDisplayOnly<T>(capture: () => Promise<T>): Promise<T> {
		if (!this.set?.hasGoogle) return capture();
		this.hidden = true;
		try {
			return await capture();
		} finally {
			this.hidden = false;
			this.onChange();
		}
	}

	attribution(): string | null {
		return this.active && this.set ? this.set.attributions() : null;
	}

	get tiles(): Tiles3DSet | null {
		return this.set;
	}

	dispose() {
		this.disposed = true;
		this.pending = null;
		cancelAnimationFrame(this.raf);
		this.set?.dispose();
		this.set = null;
		this.active = false;
	}
}
