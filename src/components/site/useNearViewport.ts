// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	createElement,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";

/** True (and stays true) once the element is within `margin` px of the viewport vertically. */
export function useNearViewport(margin = 600) {
	const ref = useRef<HTMLDivElement>(null);
	const [near, setNear] = useState(false);
	useEffect(() => {
		const el = ref.current;
		if (!el || near) return;
		const io = new IntersectionObserver(
			([e]) => {
				if (e?.isIntersecting) {
					setNear(true);
					io.disconnect();
				}
			},
			{ rootMargin: `${margin}px 0px` },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [margin, near]);
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
