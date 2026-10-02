// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useReducedMotion } from "./hooks";

// The alignment story: one figure tells "the phone's guess, then the fix", and every view in it (the
// Compare wipe, a Stages stepper, the side map, the geo bleed around a photo) reads and writes one
// number, t: 0 = the sensor prior, 1 = the solved pose. Values in between are only a visual tween
// between the two measured poses; numbers shown to the reader are always the measured endpoints.

export type AlignmentStory = {
	t: number;
	setT: (t: number) => void;
};

const StoryContext = createContext<AlignmentStory | null>(null);

/** Shares one prior → solved position between the views inside it. */
export function AlignmentStoryProvider({
	initial = 0.5,
	children,
}: {
	initial?: number;
	children: ReactNode;
}) {
	const [t, setRaw] = useState(initial);
	const value = useMemo(
		() => ({ t, setT: (v: number) => setRaw(Math.min(1, Math.max(0, v))) }),
		[t],
	);
	return (
		<StoryContext.Provider value={value}>{children}</StoryContext.Provider>
	);
}

/** The enclosing alignment story, or null outside one. */
export const useAlignmentStory = () => useContext(StoryContext);

type Pose = {
	yaw: number;
	pitch: number;
	roll: number;
	f: number;
	hfov: number;
};

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** The camera between the prior (t = 0) and the solved pose (t = 1); yaw takes the short way round. */
export function poseAt(d: { prior: Pose; solved: Pose }, t: number): Pose {
	const a = d.prior;
	const b = d.solved;
	const mix = (x: number, y: number) => x + (y - x) * t;
	return {
		yaw: a.yaw + wrap180(b.yaw - a.yaw) * t,
		pitch: mix(a.pitch, b.pitch),
		roll: mix(a.roll, b.roll),
		f: mix(a.f, b.f),
		hfov: mix(a.hfov, b.hfov),
	};
}

/** Eases a value towards `target` (about `ms` to settle); jumps under reduced motion. */
export function useTween(target: number, ms = 520): number {
	const reduce = useReducedMotion();
	const [v, setV] = useState(target);
	const cur = useRef(target);
	useEffect(() => {
		if (reduce) {
			cur.current = target;
			setV(target);
			return;
		}
		const from = cur.current;
		if (Math.abs(from - target) < 1e-4) return;
		const t0 = performance.now();
		let raf = 0;
		const tick = (now: number) => {
			const u = Math.min(1, (now - t0) / ms);
			const e = 1 - (1 - u) ** 3;
			cur.current = from + (target - from) * e;
			setV(cur.current);
			if (u < 1) raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [target, ms, reduce]);
	return v;
}
