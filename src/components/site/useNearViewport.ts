// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	createElement,
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";

/** `releaseWhenFar` defaults: far = this many viewport heights past the viewport, for this long. */
const RELEASE_DISTANCE = 1.5;
const RELEASE_AFTER_MS = 4000;

/**
 * True once the element is within `margin` px of the viewport vertically, and by default stays true.
 * With `releaseWhenFar` it goes false again after the element has stayed more than ~1.5 viewport
 * heights away for a few seconds (hysteresis), so a GPU embed can unmount, free its context and show
 * its poster; scrolling back makes it true again.
 */
export function useNearViewport(
	margin = 600,
	options?: {
		releaseWhenFar?: boolean;
		/** observe this element instead of the returned ref's */
		ref?: RefObject<HTMLDivElement | null>;
	},
) {
	const releaseWhenFar = options?.releaseWhenFar ?? false;
	const ownRef = useRef<HTMLDivElement>(null);
	const ref = options?.ref ?? ownRef;
	const [near, setNear] = useState(false);
	useEffect(() => {
		const el = ref.current;
		if (!el || near) return;
		const io = new IntersectionObserver(
			([e]) => {
				if (e?.isIntersecting) {
					setNear(true);
					if (!releaseWhenFar) io.disconnect();
				}
			},
			{ rootMargin: `${margin}px 0px` },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [margin, near, releaseWhenFar, ref]);
	useEffect(() => {
		const el = ref.current;
		if (!el || !near || !releaseWhenFar) return;
		let timer = 0;
		const far = Math.max(
			margin,
			Math.round(RELEASE_DISTANCE * window.innerHeight),
		);
		const io = new IntersectionObserver(
			([e]) => {
				window.clearTimeout(timer);
				if (!e?.isIntersecting)
					timer = window.setTimeout(() => setNear(false), RELEASE_AFTER_MS);
			},
			{ rootMargin: `${far}px 0px` },
		);
		io.observe(el);
		return () => {
			window.clearTimeout(timer);
			io.disconnect();
		};
	}, [margin, near, releaseWhenFar, ref]);
	return { ref, near };
}

/**
 * Mounts `children` (typically a React.lazy component inside Suspense) once near the viewport; until
 * then renders a placeholder box of the same size, so nothing shifts.
 */
export function NearViewport({
	className,
	margin,
	placeholder,
	children,
}: {
	/** optional wrapper class; size the placeholder so the swap does not shift layout */
	className?: string;
	margin?: number;
	placeholder?: ReactNode;
	children: ReactNode;
}) {
	const { ref, near } = useNearViewport(margin);
	return createElement(
		"div",
		{ ref, className },
		near ? children : (placeholder ?? null),
	);
}
