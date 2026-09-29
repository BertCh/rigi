// Per-pixel depth split (reports/step-inside-design.md, "depth split"): the anchored model range is compared
// with the DEM range at every depth-grid cell.
//
//   sky mask says sky                                  → Sky
//   no model depth: DEM hit → Far (DEM only); no DEM → Unknown, or Sky when there is no sky mask at all
//                   (then the model's own `valid = 0` is the only sky estimate we have)
//   people mask with model depth                        → Object (forced, whatever the range)
//   anchored range > nearRadius                          → Far
//   no DEM hit behind a valid model pixel (silhouetted against the sky: hut roof, tree, climber) → Object
//   range < dem·(1 − objectMargin) and dem − range ≥ minGapM → Object
//   otherwise (≈ DEM, or behind it)                     → Terrain
// The anchored range is the range-dependent curve when the fit has one (anchor.anchoredRange). A failed fit
// (AnchorFit.n below ANCHOR_QUALITY_CONSTS.nMin) splits by the DEM alone: no Object at all, model pixels with a DEM
// hit are Terrain within nearRadius and Far beyond (spike: "split only when a fit exists").
import {
	ANCHOR_QUALITY_CONSTS,
	type AnchorLike,
	anchoredRange,
} from "./anchor";
import {
	type DemRangeAt,
	type IntrinsicsNorm,
	type MaskLike,
	maskSampler,
	modelDepth,
	rayFactor,
} from "./geom";
import {
	type AnchorFit,
	DEFAULT_SPLIT,
	type NearFieldDepth,
	PixelClass,
	type SplitParams,
	type SplitResult,
} from "./types";

/**
 * Class of one anchored model sample at `range` metres against the DEM range `dem` (null = no terrain).
 * Shared by splitPixels and the per-Gaussian filter in scene.ts. Assumes the sample has model depth and is
 * not sky.
 */
export function classifyRange(
	range: number,
	dem: number | null,
	isPerson: boolean,
	p: SplitParams = DEFAULT_SPLIT,
): PixelClass {
	if (isPerson) return PixelClass.Object;
	if (!(range <= p.nearRadius)) return PixelClass.Far;
	if (dem == null || !(dem > 0)) return PixelClass.Object;
	if (range < dem * (1 - p.objectMargin) && dem - range >= p.minGapM)
		return PixelClass.Object;
	return PixelClass.Terrain;
}

/**
 * Split every depth-grid cell. `K` (normalised photo intrinsics) converts z-depth to ray length; it defaults
 * to the model's own intrinsicsNorm, else a 60° vertical FOV guess, so pass the photo's (geom.intrinsicsFromPose).
 */
export function splitPixels(
	depth: NearFieldDepth,
	anchor: AnchorLike & Partial<Pick<AnchorFit, "n">>,
	demRangeAt: DemRangeAt,
	skyMask: MaskLike | null,
	peopleMask: MaskLike | null,
	params: SplitParams = DEFAULT_SPLIT,
	K?: IntrinsicsNorm,
): SplitResult {
	const { width: W, height: H } = depth;
	const Kx: IntrinsicsNorm = K ??
		depth.intrinsicsNorm ?? {
			fx: 0.866 * (H / W),
			fy: 0.866,
			cx: 0.5,
			cy: 0.5,
		};
	const sky = maskSampler(skyMask);
	const people = maskSampler(peopleMask);
	const cls = new Uint8Array(W * H);
	const counts = [0, 0, 0, 0, 0];
	const noFit = anchor.n != null && anchor.n < ANCHOR_QUALITY_CONSTS.nMin;
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			const u = (i + 0.5) / W;
			const v = (j + 0.5) / H;
			let c: PixelClass;
			if (sky?.(u, v)) c = PixelClass.Sky;
			else {
				const z = modelDepth(depth, k);
				const dem = demRangeAt(u, v);
				if (Number.isNaN(z))
					c =
						dem != null
							? PixelClass.Far
							: sky
								? PixelClass.Unknown
								: PixelClass.Sky;
				else if (noFit)
					c =
						dem == null
							? PixelClass.Unknown
							: dem <= params.nearRadius
								? PixelClass.Terrain
								: PixelClass.Far;
				else
					c = classifyRange(
						anchoredRange(anchor, z * rayFactor(Kx, u, v)),
						dem,
						!!people?.(u, v),
						params,
					);
			}
			cls[k] = c;
			counts[c]++;
		}
	return { width: W, height: H, cls, counts };
}
