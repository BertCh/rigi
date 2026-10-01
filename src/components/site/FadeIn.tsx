// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * Fades and lifts its children in the first time they scroll into view. `plain` fades opacity only
 * (no transform, so a subtree holding canvases or video is not re-rastered). The transition is
 * dropped once it has finished, so nothing keeps a compositor layer afterwards.
 */
export function FadeIn({
	children,
	className,
	delay = 0,
	plain = false,
}: {
	children: ReactNode;
	className?: string;
	delay?: number;
	plain?: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [on, setOn] = useState(false);
	const [done, setDone] = useState(false);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const io = new IntersectionObserver(
			([e]) => {
				if (e.isIntersecting) {
					setOn(true);
					io.disconnect();
				}
			},
			{ rootMargin: "0px 0px -12% 0px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, []);
	// after the fade, strip every transition/transform class so no layer is promoted
	const hidden = plain ? "opacity-0" : "translate-y-6 opacity-0";
	const shown = plain ? "opacity-100" : "translate-y-0 opacity-100";
	return (
		<div
			ref={ref}
			className={`${done ? "" : "transition duration-1000 ease-out motion-reduce:transition-none"} ${on ? (done ? "" : shown) : hidden} ${className ?? ""}`}
			style={done ? undefined : { transitionDelay: `${delay}ms` }}
			onTransitionEnd={(e) => {
				if (on && e.target === e.currentTarget) setDone(true);
			}}
		>
			{children}
		</div>
	);
}
