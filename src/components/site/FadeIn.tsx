import { type ReactNode, useEffect, useRef, useState } from "react";

/** Fades and lifts its children in the first time they scroll into view. */
export function FadeIn({
	children,
	className,
	delay = 0,
}: {
	children: ReactNode;
	className?: string;
	delay?: number;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [on, setOn] = useState(false);
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
	return (
		<div
			ref={ref}
			className={`transition duration-1000 ease-out motion-reduce:transition-none ${on ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"} ${className ?? ""}`}
			style={{ transitionDelay: `${delay}ms` }}
		>
			{children}
		</div>
	);
}
