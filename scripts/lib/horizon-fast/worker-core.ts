/** Environment-agnostic worker job: build mips for sector mosaics, march. */
import {
	computeHorizonFast,
	type Eye,
	type FastHorizonOptions,
	type FastHorizonProfile,
} from "../../../src/lib/horizon-fast/march";
import { buildMips, type Mosaic } from "../../../src/lib/horizon-fast/mosaic";

export interface SectorJob {
	id: number;
	eye: Eye;
	/** Must include i0 / i1 (the sector) and any snapped peaks in it. */
	opts: FastHorizonOptions;
	mosaics: Mosaic[];
}

export interface SectorResult {
	id: number;
	profile: FastHorizonProfile;
	/** Mip build time, ms. */
	mipMs: number;
	error?: string;
}

export function runSector(job: SectorJob): {
	result: SectorResult;
	transfer: ArrayBuffer[];
} {
	try {
		const t0 = performance.now();
		if (job.opts.mipSkip !== false)
			for (const m of job.mosaics) if (!m.mip) m.mip = buildMips(m);
		const mipMs = performance.now() - t0;
		const profile = computeHorizonFast(job.mosaics, job.eye, job.opts);
		return {
			result: { id: job.id, profile, mipMs },
			transfer: [
				profile.elevation.buffer as ArrayBuffer,
				profile.distance.buffer as ArrayBuffer,
			],
		};
	} catch (e) {
		return {
			result: {
				id: job.id,
				profile: undefined as unknown as FastHorizonProfile,
				mipMs: 0,
				error: String((e as Error)?.stack ?? e),
			},
			transfer: [],
		};
	}
}
