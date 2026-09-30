import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "#/lib/utils";

const OPEN_KEY = (id: string) => `rigi.panel.${id}`;

/** A section's remembered open state. Automation (navigator.webdriver) always starts open, so scripts find every control. */
function useSectionOpen(
	id: string | undefined,
	defaultOpen: boolean,
): [boolean, (v: boolean) => void] {
	const [open, setOpen] = useState(() => {
		if (!id) return true;
		try {
			if (navigator.webdriver) return true;
			const s = localStorage.getItem(OPEN_KEY(id));
			return s == null ? defaultOpen : s === "1";
		} catch {
			return defaultOpen;
		}
	});
	return [
		open,
		(v) => {
			setOpen(v);
			try {
				if (id) localStorage.setItem(OPEN_KEY(id), v ? "1" : "0");
			} catch {
				// storage unavailable: remembered for this page only
			}
		},
	];
}

/**
 * A sidebar section. With `collapse` the title becomes a disclosure whose open state is remembered
 * per id (localStorage rigi.panel.<id>); `summary` is shown beside the title while it is closed.
 */
export function Section({
	title,
	children,
	aside,
	collapse,
	summary,
	icon,
}: {
	title: string;
	children: ReactNode;
	aside?: ReactNode;
	collapse?: { id: string; defaultOpen?: boolean };
	summary?: ReactNode;
	icon?: ReactNode;
}) {
	const [open, setOpen] = useSectionOpen(
		collapse?.id,
		collapse?.defaultOpen ?? true,
	);
	const heading = (
		<h3 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.14em] text-white/55 uppercase">
			{collapse && (
				<ChevronRight
					className={cn(
						"size-3.5 text-white/35 transition-transform",
						open && "rotate-90",
					)}
				/>
			)}
			{icon}
			{title}
		</h3>
	);
	return (
		<section
			className="border-b border-white/8 px-4 py-3.5"
			data-section={collapse?.id}
			data-open={collapse ? String(open) : undefined}
		>
			<div className="flex min-h-5 items-center justify-between gap-2">
				{collapse ? (
					<button
						type="button"
						aria-expanded={open}
						onClick={() => setOpen(!open)}
						className="flex min-w-0 flex-1 items-center gap-2 text-left hover:[&_h3]:text-white/85"
					>
						{heading}
						{!open && summary && (
							<span className="truncate text-[10px] text-white/35">
								{summary}
							</span>
						)}
					</button>
				) : (
					heading
				)}
				{aside}
			</div>
			{open && <div className="mt-3 space-y-3">{children}</div>}
		</section>
	);
}

/**
 * A tier heading in the sidebar: groups sections by concern (View, Pose, Advanced). Purely a label
 * row; the sections below it carry their own collapse state.
 */
export function PanelBand({
	label,
	hint,
	tone = "default",
}: {
	label: string;
	hint?: ReactNode;
	tone?: "default" | "muted";
}) {
	return (
		<div
			className={cn(
				"flex items-baseline justify-between gap-2 border-b px-4 pt-5 pb-1.5",
				tone === "muted"
					? "border-amber-300/15 bg-amber-300/[0.03]"
					: "border-white/10 bg-white/[0.02]",
			)}
		>
			<span
				className={cn(
					"text-[10px] font-bold tracking-[0.2em] uppercase",
					tone === "muted" ? "text-amber-200/60" : "text-cyan-200/70",
				)}
			>
				{label}
			</span>
			{hint && <span className="text-[10px] text-white/30">{hint}</span>}
		</div>
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
