// GA4 (reports/geometry-first-pose.md G4): lakes as known horizontal planes.
//
// waterlineFactors: the concord WP-C water cues (src/lib/concord/cues/water.ts waterCuesX) as geocam
// factors. Two families:
//   "level"  far-shore waterline elevation, px @1600 (cueResidualPx "level": f·(el(observed ray) −
//            el(lake-level shore point from the CURRENT eye))). The dip θ ≈ (h_eye − h_lake)/d makes it
//            an eye-height measurement (σ_h ≈ d·σ_θ) once the skyline pins pitch.
//   "shore"  signed distance of the observed ray's lake-plane hit to the OSM outline, converted to px by
//            its image gradient (cueResidualPx "shore"): adds XY and a second Z handle.
// The residual is an explicit function of the state for a fixed cue set (observed pixel fixed, target
// point fixed in the scene frame, eye and rotation from x). The cue set itself depends on the camera
// (predicted waterline columns, search window around the prediction), so a `WaterSource` re-extracts
// the cues in relinearize() at the current camera (outer loop of the MAP solver).
//
// Cue bias. Concord measured a −1.3…−4 px offset of the waterline cues at the GT pose on the dev lakes
// (tools/concord/cues/RESULT.txt), i.e. a detector / shore-vegetation effect, not pose. A constant px
// offset b in the level residuals is collinear with pitch and, at one shore distance d, with eye height
// (δZ = b·d/f: 3.6 m for b = −2.5 px at 2 km, f ≈ 1400). It is therefore NOT corrected by a constant
// fitted on dev: each family carries its own bias nuisance b ~ N(0, biasSigmaPx²) which is profiled out
// in closed form (variable projection: rows (r_i − b̂)/σ_i plus one prior row b̂/σ_b, with b̂ the
// precision-weighted mean of the rows under that prior). For an L2 loss this is exactly the marginal
// likelihood with covariance diag(σ²) + σ_b²·11ᵀ; under the robust loss b̂ uses the rows' Cauchy
// weights at the previous residual set (IRLS-consistent, smooth enough for central differences). The
// eye-Z information that survives is the 1/d spread across shore distances, plus the prior-limited
// part σ_b. Set biasSigmaPx = 0 to turn the nuisance off (plain rows).
// The calm-water mirror-axis variant (water.ts mirrorHalfPx) is forced OFF: on the dev lakes it was 3×
// rougher along the shore and worse against the 6971 hand pins than the edge search.
//
// lakeFloorFactor: one-sided eye floor U ≥ level + margin (scene-frame z), the GA0 "eye ≥ lake level"
// rule as a prior factor (zero residual when satisfied, stiff quadratic below). It is a veto-style
// bound, not a pull (guard-rail 2).

import type { WaterCue } from "../../concord/cues/water";
import { cueResidualPx, type JointCue } from "../map/joint-residual";
import {
	type CameraX,
	type CueFamily,
	cameraXFromState,
	type Factor,
	type GeoState,
	IDX,
	type Loss,
	NP,
} from "../core";

/** Cue provider at a camera (e.g. a closure over waterCuesX with a GeomBuffer cast at `cam`). */
export type WaterSource = (cam: CameraX) => WaterCue[] | Promise<WaterCue[]>;

export type WaterlineOpts = {
	/** Families to emit. Default both. */
	families?: ("level" | "shore")[];
	/** Robust loss on the whitened rows. Default Cauchy c = 2 (as the skyline factor). */
	loss?: Loss;
	/** Per-family bias nuisance σ (px @1600); 0 = off. Default 3 (covers concord's −1.3…−4 px). */
	biasSigmaPx?: number;
	/** Effective-count cap per family (grid thinning; JOINT_DEFAULTS groupEff). Default 20 / 20. */
	nEff?: { level?: number; shore?: number };
	/** Minimum valid cues for a family to emit rows (fewer ⇒ all NaN). Default 4. */
	minCues?: number;
	/** Row σ floor (px @1600) added in quadrature to the cue's own sigmaPx. Default 0. */
	sigmaFloorPx?: number;
	/** Frame for shore cues without `world` (unused for WaterCue, which always carries world). */
	frame?: { alt0: number; rEff: number };
};

export const WATERLINE_DEFAULTS = {
	loss: { kind: "cauchy", c: 2 } as Loss,
	biasSigmaPx: 3,
	nEffLevel: 20,
	nEffShore: 20,
	minCues: 4,
};

type Fam = "level" | "shore";

/** Cauchy / Huber / Student IRLS weight at whitened z (l2 ⇒ 1). */
function lossWeight(loss: Loss, z: number): number {
	const a = Math.abs(z);
	switch (loss.kind) {
		case "l2":
			return 1;
		case "huber":
			return a <= loss.c ? 1 : loss.c / a;
		case "cauchy":
			return 1 / (1 + (z / loss.c) ** 2);
		case "student":
			return (loss.nu + 1) / (loss.nu + z * z);
	}
}

/** Mutable cue store shared by the two family factors (one extraction per relinearisation). */
class WaterState {
	cues: WaterCue[] = [];
	lastX: GeoState | null = null;
	/** Robust weights of the previous evaluation per family (for b̂). */
	weights: Record<Fam, Float64Array | null> = { level: null, shore: null };
	constructor(
		readonly base: CameraX,
		readonly src: WaterCue[] | WaterSource,
	) {
		if (Array.isArray(src)) this.cues = src;
	}
	async relinearize(x: GeoState) {
		if (Array.isArray(this.src)) return;
		if (this.lastX && sameState(this.lastX, x)) return;
		this.lastX = Float64Array.from(x);
		this.cues = await this.src(cameraXFromState(this.base, x));
		this.weights = { level: null, shore: null };
	}
	of(f: Fam): WaterCue[] {
		return this.cues.filter((c) => c.kind === f);
	}
}

const sameState = (a: GeoState, b: GeoState) => {
	for (let i = 0; i < NP; i++) if (a[i] !== b[i]) return false;
	return true;
};

/**
 * Factors for the waterline ("level") and shoreline ("shore") cues. `src` is either a fixed cue list
 * (extracted at some camera; no re-extraction) or a WaterSource re-run in relinearize(). Each family
 * is one Factor with dim = cues + 1 (the bias-nuisance prior row; always present, 0 when off).
 * `dim` is a live getter: it changes when relinearize() re-extracts.
 */
export function waterlineFactors(
	src: WaterCue[] | WaterSource,
	base: CameraX,
	opts: WaterlineOpts = {},
): Factor[] {
	const st = new WaterState(base, src);
	const fams = opts.families ?? ["level", "shore"];
	return fams.map((f) => familyFactor(st, f, opts));
}

function familyFactor(st: WaterState, fam: Fam, o: WaterlineOpts): Factor {
	const loss = o.loss ?? WATERLINE_DEFAULTS.loss;
	const sb = o.biasSigmaPx ?? WATERLINE_DEFAULTS.biasSigmaPx;
	const minCues = o.minCues ?? WATERLINE_DEFAULTS.minCues;
	const floor = o.sigmaFloorPx ?? 0;
	const nEff =
		fam === "level"
			? (o.nEff?.level ?? WATERLINE_DEFAULTS.nEffLevel)
			: (o.nEff?.shore ?? WATERLINE_DEFAULTS.nEffShore);
	const family: CueFamily = fam;
	const factor: Factor = {
		family,
		name: `water:${fam}`,
		get dim() {
			return st.of(fam).length + 1;
		},
		loss,
		nEff,
		residual(x: GeoState): Float64Array {
			const cues = st.of(fam);
			const out = new Float64Array(cues.length + 1).fill(Number.NaN);
			const cam = cameraXFromState(st.base, x);
			const r = new Float64Array(cues.length);
			const s = new Float64Array(cues.length);
			let nOk = 0;
			for (let i = 0; i < cues.length; i++) {
				const c = cues[i];
				r[i] = cueResidualPx(cam, c as JointCue, 0, o.frame)[0];
				s[i] = Math.hypot(c.sigmaPx, floor);
				if (Number.isFinite(r[i])) nOk++;
			}
			if (nOk < minCues) return out;
			// profiled bias b̂ (precision-weighted mean with the N(0, σb²) prior)
			let b = 0;
			if (sb > 0) {
				const w = st.weights[fam];
				let num = 0;
				let den = 1 / (sb * sb);
				for (let i = 0; i < cues.length; i++) {
					if (!Number.isFinite(r[i])) continue;
					const wi = (w && w.length === cues.length ? w[i] : 1) / (s[i] * s[i]);
					num += wi * r[i];
					den += wi;
				}
				b = num / den;
			}
			for (let i = 0; i < cues.length; i++)
				if (Number.isFinite(r[i])) out[i] = (r[i] - b) / s[i];
			out[cues.length] = sb > 0 ? b / sb : 0;
			return out;
		},
		async relinearize(x: GeoState) {
			await st.relinearize(x);
			// refresh the robust weights for b̂ at this state (one IRLS step, frozen during the inner loop)
			st.weights[fam] = null;
			const z = factor.residual(x);
			const cues = st.of(fam);
			const w = new Float64Array(cues.length);
			for (let i = 0; i < cues.length; i++)
				w[i] = Number.isFinite(z[i]) ? lossWeight(loss, z[i]) : 0;
			st.weights[fam] = w;
		},
	};
	return factor;
}

/** Profiled bias (px @1600) of a family at x, for reports: −b̂·σ_b recovered from the prior row. */
export function waterlineBiasPx(
	f: Factor,
	x: GeoState,
	biasSigmaPx = 3,
): number {
	const z = f.residual(x);
	return z.length ? z[z.length - 1] * biasSigmaPx : Number.NaN;
}

export type LakeFloorOpts = {
	/** Eye must be at least this far above the level (m). Default 0.3 (lakes/floor.ts margin). */
	marginM?: number;
	/** Stiffness below the floor (m). Default 0.25. */
	sigmaM?: number;
};

/**
 * One-sided eye floor: U ≥ levelZ + margin, levelZ in the SCENE frame (absolute level − alt0 −
 * curvature drop at the eye, i.e. what lakes/floor.ts returns converted by the caller). Zero residual
 * above; (floor − U)/σ below. Prior factor (excluded from the MAD rescale), analytic Jacobian.
 */
export function lakeFloorFactor(levelZ: number, o: LakeFloorOpts = {}): Factor {
	const floorZ = levelZ + (o.marginM ?? 0.3);
	const sig = o.sigmaM ?? 0.25;
	return {
		family: "lakeFloor",
		name: "lakeFloor",
		dim: 1,
		loss: { kind: "l2" },
		prior: true,
		residual: (x) =>
			Float64Array.of(x[IDX.U] < floorZ ? (floorZ - x[IDX.U]) / sig : 0),
		jacobian: (x) => {
			const j = new Float64Array(NP);
			if (x[IDX.U] < floorZ) j[IDX.U] = -1 / sig;
			return j;
		},
	};
}
