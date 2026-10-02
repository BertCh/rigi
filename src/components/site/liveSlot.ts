// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// One live GPU embed at a time on the landing page, give or take a scroll transition. Every live
// embed (the panorama strip, the live roll map, Step Inside) owns a GPU context; on their own they
// only free it once ~1.5 viewport heights away for a few seconds (useNearViewport's releaseWhenFar),
// and since the sections are neighbours two or three contexts stayed alive together. Here an embed
// that is live but scrolled off screen is evicted (unmounted, its context freed, its poster shown)
// as soon as another live embed is on screen. Scrolling back onto it brings it back.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNearViewport } from "./useNearViewport";

/** `seen`: on screen at some point since it went live (a preloading embed below the fold is not). */
export type EmbedState = { live: boolean; onScreen: boolean; seen: boolean };

/** Delay before an off-screen embed is evicted, so a quick scroll past does not churn contexts. */
export const EVICT_AFTER_MS = 1200;

const embeds = new Map<string, EmbedState>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
	version++;
	for (const l of listeners) l();
}

/** Record an embed's state (live = holding its GPU context, onScreen = any pixel in view). */
export function reportEmbed(id: string, state: EmbedState) {
	const old = embeds.get(id);
	if (
		old &&
		old.live === state.live &&
		old.onScreen === state.onScreen &&
		old.seen === state.seen
	)
		return;
	embeds.set(id, state);
	notify();
}

export function removeEmbed(id: string) {
	if (embeds.delete(id)) notify();
}

/** True when `id` is live, was seen and is now off screen, while another live embed is on screen. */
export function shouldEvict(
	id: string,
	all: ReadonlyMap<string, EmbedState>,
): boolean {
	const me = all.get(id);
	if (!me?.live || !me.seen || me.onScreen) return false;
	for (const [other, s] of all)
		if (other !== id && s.live && s.onScreen) return true;
	return false;
}

function subscribe(l: () => void) {
	listeners.add(l);
	return () => listeners.delete(l);
}
const getVersion = () => version;

/**
 * useNearViewport(margin, { releaseWhenFar }) plus the one-live-embed rule: `live` is true while the
 * embed should hold its engine. Key the engine's effect on `live` instead of `near`.
 */
export function useLiveEmbed(
	id: string,
	margin: number,
	options?: { ref?: React.RefObject<HTMLDivElement | null> },
) {
	const { ref, near } = useNearViewport(margin, {
		releaseWhenFar: true,
		ref: options?.ref,
	});
	const [onScreen, setOnScreen] = useState(false);
	const [evicted, setEvicted] = useState(false);
	const live = near && !evicted;
	const tick = useSyncExternalStore(subscribe, getVersion, getVersion);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const io = new IntersectionObserver(([e]) => {
			setOnScreen(!!e?.isIntersecting);
			if (e?.isIntersecting) setEvicted(false);
		});
		io.observe(el);
		return () => io.disconnect();
	}, [ref]);

	const [seen, setSeen] = useState(false);
	useEffect(() => {
		if (!live) setSeen(false);
		else if (onScreen) setSeen(true);
	}, [live, onScreen]);
	useEffect(() => {
		reportEmbed(id, { live, onScreen, seen });
	}, [id, live, onScreen, seen]);
	useEffect(() => () => removeEmbed(id), [id]);

	const timer = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: tick re-runs the check on any embed's change
	useEffect(() => {
		window.clearTimeout(timer.current);
		if (!shouldEvict(id, embeds)) return;
		timer.current = window.setTimeout(() => {
			if (shouldEvict(id, embeds)) setEvicted(true);
		}, EVICT_AFTER_MS);
		return () => window.clearTimeout(timer.current);
	}, [id, tick]);

	return { ref, live, onScreen };
}
