import type { ReactNode } from "react";
import { cn } from "#/lib/utils";

export function Section({
	title,
	children,
	aside,
}: {
	title: string;
	children: ReactNode;
	aside?: ReactNode;
}) {
	return (
		<section className="border-b border-white/8 px-4 py-4">
			<div className="mb-3 flex items-center justify-between">
				<h3 className="text-[11px] font-semibold tracking-[0.14em] text-white/45 uppercase">
					{title}
				</h3>
				{aside}
			</div>
			<div className="space-y-3">{children}</div>
		</section>
	);
}

export function Slider({
	label,
	value,
	min,
	max,
	step = 0.01,
	onChange,
	format = (v) => v.toFixed(2),
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	onChange: (v: number) => void;
	format?: (v: number) => string;
}) {
	return (
		<label className="block">
			<div className="mb-1 flex justify-between text-xs text-white/70">
				<span>{label}</span>
				<span className="font-mono text-white/50 tabular-nums">
					{format(value)}
				</span>
			</div>
			<input
				type="range"
				className="mt-range w-full"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
			/>
		</label>
	);
}

export function Segmented<T extends string>({
	value,
	options,
	onChange,
	size = "md",
}: {
	value: T;
	options: { value: T; label: ReactNode; title?: string }[];
	onChange: (v: T) => void;
	size?: "sm" | "md";
}) {
	return (
		<div className="flex rounded-lg bg-white/6 p-0.5 ring-1 ring-white/8">
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					title={o.title}
					onClick={() => onChange(o.value)}
					className={cn(
						"flex-1 rounded-md font-medium transition-colors",
						size === "sm" ? "px-2 py-1 text-[11px]" : "px-2.5 py-1.5 text-xs",
						value === o.value
							? "bg-white text-slate-900 shadow"
							: "text-white/60 hover:text-white",
					)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}

export function Toggle({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onChange(!checked)}
			className="flex w-full items-center justify-between text-xs text-white/70"
		>
			<span>{label}</span>
			<span
				className={cn(
					"relative h-4 w-7 rounded-full transition-colors",
					checked ? "bg-cyan-400" : "bg-white/15",
				)}
			>
				<span
					className={cn(
						"absolute top-0.5 size-3 rounded-full bg-white transition-all",
						checked ? "left-3.5" : "left-0.5",
					)}
				/>
			</span>
		</button>
	);
}

/** Label left, a 16 px colour swatch right (a native colour picker underneath), matching Toggle's row. */
export function ColorSwatch({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (hex: `#${string}`) => void;
}) {
	return (
		<label className="flex w-full cursor-pointer items-center justify-between text-xs text-white/70">
			<span>{label}</span>
			<span
				className="relative size-4 overflow-hidden rounded ring-1 ring-white/25"
				style={{ backgroundColor: value }}
			>
				<input
					type="color"
					value={value}
					onChange={(e) => onChange(e.target.value as `#${string}`)}
					className="absolute inset-0 size-full cursor-pointer opacity-0"
					aria-label={label}
				/>
			</span>
		</label>
	);
}

export function Button({
	children,
	onClick,
	variant = "ghost",
	className,
	disabled,
	title,
}: {
	children: ReactNode;
	onClick?: () => void;
	variant?: "ghost" | "solid" | "accent";
	className?: string;
	disabled?: boolean;
	title?: string;
}) {
	return (
		<button
			type="button"
			title={title}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40",
				variant === "ghost" &&
					"bg-white/6 text-white/80 ring-1 ring-white/10 hover:bg-white/12",
				variant === "solid" && "bg-white text-slate-900 hover:bg-white/90",
				variant === "accent" && "bg-cyan-400 text-slate-950 hover:bg-cyan-300",
				className,
			)}
		>
			{children}
		</button>
	);
}
