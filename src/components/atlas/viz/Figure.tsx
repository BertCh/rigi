import type { ReactNode } from "react";
import { cn } from "#/lib/utils";
import { useInView } from "./hooks";

/** Framed figure with a mono caption. Fades in on first view. `bleed` lets it span wider than prose. */
export function Figure({
	children,
	caption,
	label,
	className,
	bleed,
	pad = true,
}: {
	children: ReactNode;
	caption?: ReactNode;
	label?: string;
	className?: string;
	bleed?: boolean;
	pad?: boolean;
}) {
	const [ref, on] = useInView();
	return (
		<figure
			ref={ref}
			className={cn(
				"my-9 transition duration-1000 ease-out motion-reduce:transition-none",
				on ? "translate-y-0 opacity-100" : "translate-y-5 opacity-0",
				bleed && "lg:-mx-12",
				className,
			)}
		>
			<div
				className={cn(
					"overflow-hidden rounded-2xl bg-white/[0.03] ring-1 ring-white/10",
					pad && "p-4 sm:p-6",
				)}
			>
				{children}
			</div>
			{(caption || label) && (
				<figcaption className="mt-2.5 flex gap-3 px-1 font-mono text-[10.5px] leading-relaxed text-white/40">
					{label && <span className="text-[var(--accent)]">{label}</span>}
					<span>{caption}</span>
				</figcaption>
			)}
		</figure>
	);
}
