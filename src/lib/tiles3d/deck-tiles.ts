// deck/engine.ts's side of Step Inside 3D Tiles (three-tiles.ts's twin): owns the photo's Tiles3DSet,
// refines it from the deck world camera (a THREE camera) while stepping and hands worldLayers() a
// Tiles3DDeckLayer. Tile arrivals are coalesced to one layer update per animation frame.
import type * as THREE from "three";
import type { PhotoRangeMap } from "../deck/terrain-layer";
import {
	PROVENANCE_COLORS,
	PROVENANCE_TINT_MIX,
} from "../nearfield/provenance";
import { type Tiles3DConfig, tiles3dConfig } from "./config";
import { Tiles3DDeckLayer } from "./deck-layer";
import { Tiles3DSet } from "./tiles";

export class DeckTiles3D {
	private set: Tiles3DSet | null = null;
	private active = false;
	private hidden = false;
	private raf = 0;

	private constructor(
		private config: Tiles3DConfig,
		private onChange: () => void,
	) {}

	/** null when ?tiles3d is off (the default): deck/engine.ts then never touches tiles. */
	static create(onChange: () => void): DeckTiles3D | null {
		const config = tiles3dConfig();
		return config ? new DeckTiles3D(config, onChange) : null;
	}

	enter(lat: number, lon: number, eye: THREE.Vector3) {
		if (!this.set) {
			this.set = new Tiles3DSet(this.config, { lat, lon, eye });
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
		if (!set || !this.active) return null;
		const d = PROVENANCE_COLORS.dem;
		return new Tiles3DDeckLayer({
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
			// Truth view: Google is not ours to label (three-tiles.ts); exports never carry it
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
		cancelAnimationFrame(this.raf);
		this.set?.dispose();
		this.set = null;
		this.active = false;
	}
}
