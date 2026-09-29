// Sidebar section for the overlay reveal: preset grid, timing / light / texture sliders, replay.
import { Play, RotateCcw } from "lucide-react";
import { useState } from "react";
import {
	Button,
	ColorSwatch,
	Section,
	Slider,
	Toggle,
} from "#/components/controls";
import { cn } from "#/lib/utils";
import {
	DEFAULT_REVEAL,
	presetById,
	REVEAL_PRESETS,
	type RevealConfig,
} from "./config";

export function RevealPanel({
	cfg,
	onChange,
	onReplay,
	onSeek,
	playing,
}: {
	cfg: RevealConfig;
	onChange: (p: Partial<RevealConfig>) => void;
	/** replay with this config (the panel passes the edited one, state may lag a frame) */
	onReplay: (cfg: RevealConfig) => void;
	/** freeze at linear progress k (1 = finished / off); `first` re-measures the view */
	onSeek: (cfg: RevealConfig, k: number, first: boolean) => void;
	playing: boolean;
}) {
	const preset = presetById(cfg.preset);
	const [scrub, setScrub] = useState(1);
	const set = (p: Partial<RevealConfig>, replay = false) => {
		onChange(p);
		if (replay) {
			setScrub(1);
			onReplay({ ...cfg, ...p });
		} else if (scrub < 1) onSeek({ ...cfg, ...p }, scrub, false);
	};
	return (
		<Section
			title="Reveal"
			aside={
				<Button
					onClick={() => {
						setScrub(1);
						onReplay(cfg);
					}}
					variant={playing ? "accent" : "ghost"}
					className="px-2 py-1"
					title="Replay the reveal"
				>
					<Play className="size-3" /> Replay
				</Button>
			}
		>
			<div className="grid grid-cols-2 gap-1.5">
				{REVEAL_PRESETS.map((p) => (
					<button
						key={p.id}
						type="button"
						title={p.blurb}
						onClick={() => set({ preset: p.id }, true)}
						className={cn(
							"group relative overflow-hidden rounded-lg px-2.5 py-2 text-left text-[11px] font-medium ring-1 transition-colors",
							cfg.preset === p.id
								? "bg-white/12 text-white ring-white/40"
								: "bg-white/4 text-white/65 ring-white/8 hover:bg-white/8 hover:text-white",
						)}
					>
						<span
							className="absolute inset-y-0 left-0 w-0.5"
							style={{ backgroundColor: p.color }}
						/>
						{p.label}
					</button>
				))}
			</div>
			<p className="text-[11px] leading-relaxed text-white/45">
				{preset.blurb}
			</p>
			<Slider
				label="Scrub"
				value={scrub}
				min={0}
				max={1}
				step={0.005}
				format={(v) => (v >= 1 ? "live" : `${Math.round(v * 100)}%`)}
				onChange={(k) => {
					onSeek(cfg, k, scrub >= 1);
					setScrub(k);
				}}
			/>
			<Slider
				label="Duration"
				value={cfg.duration ?? preset.duration}
				min={0.6}
				max={8}
				step={0.1}
				format={(v) => `${v.toFixed(1)} s`}
				onChange={(duration) => set({ duration })}
			/>
			<Slider
				label="Glow"
				value={cfg.glow}
				min={0}
				max={2.5}
				onChange={(glow) => set({ glow })}
			/>
			<Slider
				label="Edge softness"
				value={cfg.soft}
				min={0.3}
				max={3}
				format={(v) => `${v.toFixed(1)}×`}
				onChange={(soft) => set({ soft })}
			/>
			<Slider
				label="Organic edge"
				value={cfg.grain}
				min={0}
				max={4}
				format={(v) => `${v.toFixed(1)}×`}
				onChange={(grain) => set({ grain })}
			/>
			<Slider
				label="Pre-dim terrain"
				value={cfg.dim}
				min={0}
				max={0.7}
				onChange={(dim) => set({ dim })}
			/>
			<ColorSwatch
				label={cfg.color ? "Glow colour" : "Glow colour (preset)"}
				value={cfg.color ?? preset.color}
				onChange={(color) => set({ color })}
			/>
			<Toggle
				label="Reverse direction"
				checked={cfg.reverse}
				onChange={(reverse) => set({ reverse }, true)}
			/>
			<Toggle
				label="Labels pop in with the front"
				checked={cfg.labels}
				onChange={(labels) => set({ labels })}
			/>
			<Toggle
				label="Play when terrain loads"
				checked={cfg.onLoad}
				onChange={(onLoad) => set({ onLoad })}
			/>
			<Button
				className="w-full"
				onClick={() =>
					set({
						duration: null,
						glow: DEFAULT_REVEAL.glow,
						soft: DEFAULT_REVEAL.soft,
						grain: DEFAULT_REVEAL.grain,
						dim: DEFAULT_REVEAL.dim,
						color: null,
						reverse: false,
					})
				}
			>
				<RotateCcw className="size-3" /> Preset defaults
			</Button>
		</Section>
	);
}
