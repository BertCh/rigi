// The pack's peak-class index for style.terroir.peakTiers (prominence backfill). Fetches nothing
// unless `on`; findPack caches the pack, so this shares TerroirLayer's request.
import { useEffect, useState } from "react";
import { findPack } from "../pack";
import { buildTierIndex, type TierIndex } from "./peakTiers";

export function useTierIndex(lat: number, lon: number, on: boolean) {
	const [idx, setIdx] = useState<TierIndex | null>(null);
	useEffect(() => {
		if (!on) return;
		let live = true;
		findPack(lat, lon).then((p) => live && setIdx(buildTierIndex(p)));
		return () => {
			live = false;
		};
	}, [lat, lon, on]);
	return on ? idx : null;
}
