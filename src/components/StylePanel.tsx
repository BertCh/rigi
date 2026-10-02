// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The "Look" panel (styling.md §3): preset chips shared by every view, plus a per-view "Customize"
// disclosure, and the nested "Label style" / "Trail style" disclosures. Edits go to the style store
// (src/lib/style/store.ts) as diff-only overrides on the chosen preset; the engine picks them up
// through PhotoWorkspace's useViewStyle → engine.setStyle.
import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { GLOW_DEFAULT } from "#/lib/look/labels/glow";
import { storageKey } from "#/lib/ontology/core/storage";
import type { Settings } from "#/lib/settings";
import {
	ABSOLUTE_RAMP_RANGE,
	ABSOLUTE_RAMPS,
	type DeepPartial,
	getStyleStore,
	type Hex,
	hexToRgb01,
	type LabelStyle,
	PRESET_IDS,
	PRESET_LABELS,
	type PresetId,
	presetStyle,
	type RampName,
	rampCss,
	type StyleState,
	toHexString,
	type ViewStyle,
} from "#/lib/style";
import { cn } from "#/lib/utils";
import {
	Button,
	ColorSwatch,
	Section,
	Segmented,
	Slider,
	Toggle,
} from "./controls";

type Mode = Settings["mode"];
const patch = (p: DeepPartial<ViewStyle>) => getStyleStore().patch(p);

// ---- small helpers ------------------------------------------------------------------------------

function useRemembered(
	key: string,
	initial: boolean,
): [boolean, (v: boolean) => void] {
	const [v, setV] = useState(() => {
		try {
			const s = window.localStorage.getItem(key);
			return s == null ? initial : s === "1";
		} catch {
			return initial;
		}
	});
	return [
		v,
		(n) => {
			setV(n);
			try {
				window.localStorage.setItem(key, n ? "1" : "0");
			} catch {
				// storage unavailable: remembered for this page only
			}
		},
	];
}

function Disclosure({
	label,
	open,
	onToggle,
	children,
}: {
	label: string;
	open: boolean;
	onToggle: (v: boolean) => void;
	children: ReactNode;
}) {
	return (
		<div>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => onToggle(!open)}
				className="flex items-center gap-1 text-[11px] font-medium text-white/55 hover:text-white/85"
			>
				<ChevronRight
					className={cn("size-3.5 transition-transform", open && "rotate-90")}
				/>
				{label}
			</button>
			{open && (
				<div className="mt-3 space-y-3 border-l border-white/8 pl-3">
					{children}
				</div>
			)}
		</div>
	);
}

function Group({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="space-y-2.5">
			<div className="text-[10px] font-semibold tracking-[0.12em] text-white/35 uppercase">
				{title}
			</div>
			{children}
		</div>
	);
}

/** '#rrggbb' for a colour input (alpha dropped). */
const hex = (c: Hex) => toHexString(c, false);

/**
 * Display hex for a "raw" shader colour (ridges, casing, hairline): the classic float tuples are
 * used as linear values (style/three-apply.ts), so show what they look like on screen.
 */
function rawHex(c: Hex) {
	if (typeof c === "string") return hex(c);
	const enc = (x: number) =>
		x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
	const [r, g, b] = hexToRgb01(c);
	return toHexString([enc(r), enc(g), enc(b)], false);
}

const rampOption = (value: RampName, label: string) => ({
	value,
	label: (
		<span className="flex items-center justify-center gap-1">
			<span
				className="h-2 w-3 rounded-sm"
				style={{ background: rampCss(value, 4) }}
			/>
			{label}
		</span>
	),
	title: label,
});
/** The named ramp, or '' for a custom one (then no option is highlighted). */
const rampName = (r: unknown) => (typeof r === "string" ? r : "") as RampName;

// ---- preset chips -------------------------------------------------------------------------------

function presetSwatch(id: PresetId) {
	const s = presetStyle(id);
	const c = s.overlay.contours.color;
	return c.mode === "ramp"
		? rampCss(c.ramp, 4)
		: `linear-gradient(90deg, ${hex(c.minor)}, ${hex(c.major)})`;
}

function PresetChips({ value }: { value: PresetId }) {
	return (
		<div className="grid grid-cols-3 gap-1.5">
			{PRESET_IDS.map((id, i) => (
				<button
					key={id}
					type="button"
					title={PRESET_LABELS[id]}
					aria-pressed={value === id}
					onClick={() => getStyleStore().setPreset(id)}
					className={cn(
						"flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium ring-1 transition-colors",
						// the last chip of an unfilled row takes the free cells
						i === PRESET_IDS.length - 1 &&
							PRESET_IDS.length % 3 === 2 &&
							"col-span-2",
						i === PRESET_IDS.length - 1 &&
							PRESET_IDS.length % 3 === 1 &&
							"col-span-3",
						value === id
							? "bg-white text-slate-900 ring-white"
							: "bg-white/6 text-white/65 ring-white/8 hover:text-white",
					)}
				>
					<span
						className="size-2.5 shrink-0 rounded-sm ring-1 ring-black/20"
						style={{ background: presetSwatch(id) }}
					/>
					<span className="truncate">{PRESET_LABELS[id]}</span>
				</button>
			))}
		</div>
	);
}

// ---- shared groups ------------------------------------------------------------------------------

function ImageryGroup({
	which,
	style,
}: {
	which: "replace" | "world";
	style: ViewStyle;
}) {
	const a = style[which].imagery;
	const set = (p: Partial<ViewStyle["replace"]["imagery"]>) =>
		patch({ [which]: { imagery: p } });
	return (
		<Group title="Map colours">
			<Slider
				label="Saturation"
				value={a.saturation}
				min={0}
				max={1.5}
				onChange={(saturation) => set({ saturation })}
			/>
			<Slider
				label="Brightness"
				value={a.brightness}
				min={0.4}
				max={1.6}
				onChange={(brightness) => set({ brightness })}
			/>
			<Slider
				label="Contrast"
				value={a.contrast}
				min={0.5}
				max={1.5}
				onChange={(contrast) => set({ contrast })}
			/>
			<ColorSwatch
				label="Tint"
				value={hex(a.tint)}
				onChange={(tint) => set({ tint })}
			/>
			<Slider
				label="Tint amount"
				value={a.tintAmount}
				min={0}
				max={1}
				onChange={(tintAmount) => set({ tintAmount })}
			/>
		</Group>
	);
}

function ReliefGroup({ style }: { style: ViewStyle }) {
	const t = style.terrain;
	const sunMode = t.sun.mode === "fixed" ? "fixed" : t.sun.mode;
	const az =
		t.sun.mode === "azel" ? t.sun : { azimuthDeg: 315, elevationDeg: 45 };
	return (
		<Group title="Relief">
			<Segmented
				size="sm"
				value={sunMode}
				onChange={(m) => {
					if (m === "fixed")
						patch({ terrain: { sun: presetStyle("classic").terrain.sun } });
					else if (m === "azel")
						patch({ terrain: { sun: { mode: "azel", ...az } } });
					else patch({ terrain: { sun: { mode: "photo-time" } } });
				}}
				options={[
					{ value: "fixed", label: "Classic sun" },
					{ value: "azel", label: "Custom" },
					{
						value: "photo-time",
						label: "Photo time",
						title: "Sun position at the time the photo was taken",
					},
				]}
			/>
			{t.sun.mode === "azel" && (
				<>
					<Slider
						label="Sun azimuth"
						value={t.sun.azimuthDeg}
						min={0}
						max={360}
						step={5}
						format={(v) => `${Math.round(v)}°`}
						onChange={(azimuthDeg) =>
							patch({
								terrain: {
									sun: {
										mode: "azel",
										azimuthDeg,
										elevationDeg: az.elevationDeg,
									},
								},
							})
						}
					/>
					<Slider
						label="Sun elevation"
						value={t.sun.elevationDeg}
						min={5}
						max={85}
						step={1}
						format={(v) => `${Math.round(v)}°`}
						onChange={(elevationDeg) =>
							patch({
								terrain: {
									sun: {
										mode: "azel",
										azimuthDeg: az.azimuthDeg,
										elevationDeg,
									},
								},
							})
						}
					/>
				</>
			)}
			<Segmented
				size="sm"
				value={t.relief.mode}
				onChange={(mode) => patch({ terrain: { relief: { mode } } })}
				options={[
					{ value: "lambert", label: "Simple shade" },
					{
						value: "swiss",
						label: "Swiss relief",
						title: "Multidirectional hillshade with cast shadows and sky view",
					},
				]}
			/>
			{t.relief.mode === "swiss" && (
				<Slider
					label="Real sun"
					value={t.relief.realism}
					min={0}
					max={1}
					onChange={(realism) =>
						patch({ terrain: { relief: { mode: "swiss", realism } } })
					}
				/>
			)}
			{/* the Alpine palettes are keyed to absolute elevations (400–3500 m), the others to the local range */}
			{[
				[
					rampOption("hypso-classic", "Hypso"),
					rampOption("swiss", "Swiss"),
					rampOption("grey", "Grey"),
				],
				[
					rampOption("berann", "Berann"),
					rampOption("swiss-ok", "Atlas"),
					rampOption("patterson", "Natural"),
				],
			].map((options) => (
				<Segmented
					key={options[0].value}
					size="sm"
					value={rampName(t.reliefRamp)}
					onChange={(reliefRamp) =>
						patch({
							terrain: {
								reliefRamp,
								rampRange: ABSOLUTE_RAMPS.includes(reliefRamp)
									? ABSOLUTE_RAMP_RANGE
									: { mode: "local" },
							},
						})
					}
					options={options}
				/>
			))}
			<Toggle
				label="Alpine colours (rock, snow, lakes)"
				checked={t.albedo.mode === "alpine"}
				onChange={(on) =>
					patch({ terrain: { albedo: { mode: on ? "alpine" : "ramp" } } })
				}
			/>
			<Slider
				label="Shadow depth"
				value={t.direct}
				min={0.3}
				max={1.3}
				onChange={(direct) => patch({ terrain: { direct } })}
			/>
		</Group>
	);
}

function HazeGroup({
	which,
	style,
}: {
	which: "replace" | "world";
	style: ViewStyle;
}) {
	return (
		<Group title="Haze">
			<Slider
				label="Amount"
				value={style[which].haze}
				min={0}
				max={1.5}
				onChange={(haze) => patch({ [which]: { haze } })}
			/>
			<ColorSwatch
				label="Colour"
				value={hex(style.terrain.hazeColor)}
				onChange={(hazeColor) => patch({ terrain: { hazeColor } })}
			/>
		</Group>
	);
}

// ---- per-layer cards ----------------------------------------------------------------------------
// Every layer is styled on its own: a card holds its controls, a "copy look from <preset>" picker
// that takes just this layer's part of a preset, and a reset that drops just this layer's overrides.
// The theme chips above still set every layer at once.

type Path = readonly string[];
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const getAt = (o: unknown, p: Path) =>
	p.reduce<unknown>((x, k) => (isObj(x) ? x[k] : undefined), o);
function setAt(o: Obj, p: Path, v: unknown) {
	let cur = o;
	for (const k of p.slice(0, -1)) {
		if (!isObj(cur[k])) cur[k] = {};
		cur = cur[k] as Obj;
	}
	cur[p[p.length - 1]] = v;
}
function withoutPath(o: Obj, p: Path): Obj {
	const [k, ...rest] = p;
	if (!(k in o)) return o;
	const out = { ...o };
	const child = out[k];
	if (rest.length && isObj(child)) {
		const c = withoutPath(child, rest);
		if (Object.keys(c).length) out[k] = c;
		else delete out[k];
	} else delete out[k];
	return out;
}

type LayerDef = {
	id: string;
	title: string;
	/** the style subtrees this layer owns */
	paths: Path[];
	/** this layer's part of a preset (default: its paths, verbatim) */
	copy?: (p: ViewStyle) => DeepPartial<ViewStyle>;
};

function copyLayer(def: LayerDef, preset: PresetId) {
	const p = presetStyle(preset);
	if (def.copy) return patch(def.copy(p));
	const out: Obj = {};
	for (const path of def.paths) setAt(out, path, getAt(p, path));
	patch(out as DeepPartial<ViewStyle>);
}

function resetLayer(def: LayerDef) {
	getStyleStore().setState((s) => ({
		preset: s.preset,
		overrides: def.paths.reduce<Obj>(
			(o, p) => withoutPath(o, p),
			s.overrides as Obj,
		) as DeepPartial<ViewStyle>,
	}));
}

function LayerCard({
	def,
	active,
	state,
	children,
}: {
	def: LayerDef;
	/** whether the layer is showing in the current view (undefined = always) */
	active?: boolean;
	state: StyleState;
	children: ReactNode;
}) {
	const [open, setOpen] = useRemembered(
		storageKey("lookLayer", def.id),
		active === true,
	);
	const custom = def.paths.some((p) => getAt(state.overrides, p) !== undefined);
	return (
		<div className="rounded-lg bg-white/[0.03] ring-1 ring-white/8">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-xs font-medium text-white/80 hover:text-white"
			>
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 text-white/45 transition-transform",
						open && "rotate-90",
					)}
				/>
				<span className="flex-1 truncate">{def.title}</span>
				{custom && (
					<span
						className="size-1.5 rounded-full bg-cyan-400"
						title="Styled differently from the theme"
					/>
				)}
				{active !== undefined && (
					<span
						className={cn(
							"rounded px-1 text-[9px] font-semibold tracking-wide uppercase",
							active ? "bg-cyan-400/15 text-cyan-300" : "text-white/30",
						)}
					>
						{active ? "on" : "off"}
					</span>
				)}
			</button>
			{open && (
				<div className="space-y-3 border-t border-white/6 px-2.5 pt-2.5 pb-3">
					<div className="flex items-center gap-2">
						<select
							value=""
							onChange={(e) => {
								if (e.target.value) copyLayer(def, e.target.value as PresetId);
							}}
							aria-label={`Copy the ${def.title} look from a preset`}
							className="min-w-0 flex-1 rounded-md bg-white/6 px-2 py-1 text-[11px] text-white/70 ring-1 ring-white/8 outline-none hover:text-white"
						>
							<option value="">Copy look from preset…</option>
							{PRESET_IDS.map((id) => (
								<option key={id} value={id}>
									{PRESET_LABELS[id]}
								</option>
							))}
						</select>
						<button
							type="button"
							disabled={!custom}
							onClick={() => resetLayer(def)}
							className="text-[11px] text-white/50 hover:text-white disabled:opacity-30 disabled:hover:text-white/50"
							title="Back to the theme's look for this layer"
						>
							Reset
						</button>
					</div>
					{children}
				</div>
			)}
		</div>
	);
}

// ---- contours -----------------------------------------------------------------------------------

type LineStyle = ViewStyle["overlay"]["contours"];
type BandStyle = ViewStyle["overlay"]["bands"];
type BandLines = Exclude<BandStyle["lines"], "contours">;
const patchLines = (p: DeepPartial<LineStyle>) =>
	patch({ overlay: { contours: p } });

const pct = (v: number) => `${Math.round(v * 100)}%`;
const km = (m: number) => `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
const metres = (v: number) => (v < 1000 ? `${Math.round(v)} m` : km(v));

/** A label on the left, a compact segmented control on the right. */
function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-3 text-xs text-white/70">
			<span>{label}</span>
			<div className="w-36">{children}</div>
		</div>
	);
}

const LINE_RAMPS = [
	[
		rampOption("cool", "Cool"),
		rampOption("hypso-classic", "Hypso"),
		rampOption("viridis", "Viridis"),
		rampOption("night", "Night"),
	],
	[
		rampOption("turbo", "Turbo"),
		rampOption("swiss", "Swiss"),
		rampOption("grey", "Grey"),
		rampOption("mono-ink", "Ink"),
	],
];

const BAND_RAMPS = [
	[
		rampOption("cool", "Cool"),
		rampOption("swiss", "Swiss"),
		rampOption("viridis", "Viridis"),
		rampOption("grey", "Grey"),
	],
	[
		rampOption("hypso-classic", "Hypso"),
		rampOption("berann", "Berann"),
		rampOption("turbo", "Turbo"),
		rampOption("night", "Night"),
	],
];

const TINT_RAMPS = [
	[
		rampOption("turbo", "Turbo"),
		rampOption("viridis", "Viridis"),
		rampOption("night", "Night"),
		rampOption("cool", "Cool"),
	],
];

/** Solid-colour quick picks: [label, minor, major]. */
const LINE_SWATCHES: [string, Hex, Hex][] = [
	["White", "#ffffff", "#ffffff"],
	["Ink", "#2a2320", "#140f0c"],
	["Sepia", "#b0875a", "#7a4f2a"],
	["Orange", "#ffb070", "#ff7a2e"],
	["Cyan", "#8fe6ff", "#3fd0ff"],
];

function RampRows({
	rows,
	value,
	onChange,
}: {
	rows: ReturnType<typeof rampOption>[][];
	value: unknown;
	onChange: (r: RampName) => void;
}) {
	return (
		<>
			{rows.map((options) => (
				<Segmented
					key={options[0].value}
					size="sm"
					value={rampName(value)}
					onChange={onChange}
					options={options}
				/>
			))}
		</>
	);
}

/** Quick picks for colour sets: each button shows its colours side by side. */
function SwatchRow<T extends Hex[]>({
	sets,
	onPick,
}: {
	sets: [string, T][];
	onPick: (colors: T) => void;
}) {
	return (
		<div className="flex gap-1.5">
			{sets.map(([label, cs]) => (
				<button
					key={label}
					type="button"
					title={label}
					onClick={() => onPick(cs)}
					className="h-4 flex-1 rounded ring-1 ring-white/20 hover:ring-white/60"
					style={{
						background: `linear-gradient(90deg, ${cs
							.map(
								(c, i) =>
									`${hex(c)} ${(i * 100) / cs.length}% ${((i + 1) * 100) / cs.length}%`,
							)
							.join(", ")})`,
					}}
				/>
			))}
		</div>
	);
}

/** Width, major lines and opacities: shared by contours and the bands' own boundary lines. */
function LineShape({
	v,
	everyLabel,
	onChange,
}: {
	v: {
		width: number;
		every: number;
		majorWidthMul: number;
		minorAlpha: number;
		majorAlpha: number;
	};
	everyLabel: string;
	onChange: (p: Partial<BandLines>) => void;
}) {
	return (
		<>
			<Slider
				label="Line width"
				value={v.width}
				min={0.5}
				max={4}
				step={0.1}
				format={(x) => `${x.toFixed(1)} px`}
				onChange={(width) => onChange({ width })}
			/>
			<Row label={everyLabel}>
				<Segmented
					size="sm"
					value={String(v.every)}
					onChange={(x) => onChange({ every: Number(x) })}
					options={["2", "4", "5", "10"].map((x) => ({ value: x, label: x }))}
				/>
			</Row>
			<Slider
				label="Major line width"
				value={v.majorWidthMul}
				min={1}
				max={3}
				step={0.1}
				format={(x) => `×${x.toFixed(1)}`}
				onChange={(majorWidthMul) => onChange({ majorWidthMul })}
			/>
			<Slider
				label="Minor opacity"
				value={v.minorAlpha}
				min={0}
				max={1}
				format={pct}
				onChange={(minorAlpha) => onChange({ minorAlpha })}
			/>
			<Slider
				label="Major opacity"
				value={v.majorAlpha}
				min={0}
				max={1}
				format={pct}
				onChange={(majorAlpha) => onChange({ majorAlpha })}
			/>
		</>
	);
}

function ContourControls({ style }: { style: ViewStyle }) {
	const c = style.overlay.contours;
	const [more, setMore] = useRemembered(storageKey("lookLinesMore"), false);
	const tanaka = c.kind === "tanaka";
	return (
		<>
			<Segmented
				size="sm"
				value={c.kind}
				onChange={(kind) => patchLines({ kind })}
				options={[
					{ value: "plain", label: "Plain" },
					{
						value: "tanaka",
						label: "Illuminated",
						title:
							"Tanaka contours: lit on the sun side, shadowed on the far side",
					},
				]}
			/>
			{!tanaka && (
				<>
					<Segmented
						size="sm"
						value={c.color.mode}
						onChange={(m) =>
							patchLines({
								color:
									m === "solid"
										? { mode: "solid", minor: "#ffffff", major: "#ffffff" }
										: { mode: "ramp", ramp: "cool" },
							})
						}
						options={[
							{ value: "ramp", label: "By height" },
							{ value: "solid", label: "Solid" },
						]}
					/>
					{c.color.mode === "ramp" ? (
						<RampRows
							rows={LINE_RAMPS}
							value={c.color.ramp}
							onChange={(ramp) => patchLines({ color: { mode: "ramp", ramp } })}
						/>
					) : (
						<>
							<SwatchRow
								sets={LINE_SWATCHES.map(([l, mi, ma]) => [l, [mi, ma]])}
								onPick={([minor, major]) =>
									patchLines({ color: { mode: "solid", minor, major } })
								}
							/>
							<ColorSwatch
								label="Minor lines"
								value={hex(c.color.minor)}
								onChange={(minor) =>
									patchLines({
										color: {
											mode: "solid",
											minor,
											major: c.color.mode === "solid" ? c.color.major : minor,
										},
									})
								}
							/>
							<ColorSwatch
								label="Major lines"
								value={hex(c.color.major)}
								onChange={(major) =>
									patchLines({
										color: {
											mode: "solid",
											minor: c.color.mode === "solid" ? c.color.minor : major,
											major,
										},
									})
								}
							/>
						</>
					)}
				</>
			)}
			<LineShape
				v={{ ...c, every: c.majorEvery }}
				everyLabel="Major every"
				onChange={({ every, ...p }) =>
					patchLines(every === undefined ? p : { ...p, majorEvery: every })
				}
			/>
			{!tanaka && (
				<>
					<Toggle
						label="Dark casing"
						checked={c.casing.on}
						onChange={(on) => patchLines({ casing: { on } })}
					/>
					{c.casing.on && (
						<>
							<ColorSwatch
								label="Casing colour"
								value={rawHex(c.casing.color)}
								onChange={(color) => patchLines({ casing: { color } })}
							/>
							<Slider
								label="Casing width"
								value={c.casing.extraPx}
								min={0.5}
								max={5}
								step={0.1}
								format={(v) => `+${v.toFixed(1)} px`}
								onChange={(extraPx) => patchLines({ casing: { extraPx } })}
							/>
							<Slider
								label="Casing opacity"
								value={c.casing.alpha}
								min={0}
								max={1}
								format={pct}
								onChange={(alpha) => patchLines({ casing: { alpha } })}
							/>
						</>
					)}
				</>
			)}
			<Disclosure label="Distance fade" open={more} onToggle={setMore}>
				<Slider
					label="Start fading at"
					value={c.distFade.near}
					min={500}
					max={20000}
					step={500}
					format={km}
					onChange={(near) =>
						patchLines({
							distFade: { near, far: Math.max(c.distFade.far, near + 1000) },
						})
					}
				/>
				<Slider
					label="Fully faded at"
					value={c.distFade.far}
					min={2000}
					max={80000}
					step={1000}
					format={km}
					onChange={(far) =>
						patchLines({
							distFade: { far, near: Math.min(c.distFade.near, far - 1000) },
						})
					}
				/>
				<Slider
					label="Far-line opacity"
					value={c.distFade.floor}
					min={0}
					max={1}
					format={pct}
					onChange={(floor) => patchLines({ distFade: { floor } })}
				/>
				<Slider
					label="Thin out dense lines"
					value={1 - c.densityFade[1] / 0.4}
					min={0}
					max={1}
					format={pct}
					onChange={(v) => {
						// the classic fade (0.08–0.2 minor, 0.1–0.25 major) sits at 50%; 0% keeps
						// dense lines, 100% drops them early
						const k = Math.max(0.05, 2 * (1 - v));
						patchLines({
							densityFade: [0.08 * k, 0.2 * k, 0.1 * k, 0.25 * k],
						});
					}}
				/>
			</Disclosure>
		</>
	);
}

// ---- bands --------------------------------------------------------------------------------------

/** The contour line settings as band boundary lines (what `lines: 'contours'` draws). */
const linesFromContours = (c: LineStyle): BandLines => ({
	width: c.width,
	every: c.majorEvery,
	majorWidthMul: c.majorWidthMul,
	minorAlpha: c.minorAlpha,
	majorAlpha: c.majorAlpha,
});

/**
 * Elevation bands. Replace-bands reuses overlay.bands unless the style gives it its own
 * (replace.bands), in which case that one is edited.
 */
function BandControls({
	style,
	which,
}: {
	style: ViewStyle;
	which: "overlay" | "replace";
}) {
	const own = which === "replace" && style.replace.bands !== "overlay";
	const b: BandStyle = own
		? (style.replace.bands as BandStyle)
		: style.overlay.bands;
	const set = (p: DeepPartial<BandStyle>) =>
		own ? patch({ replace: { bands: p } }) : patch({ overlay: { bands: p } });
	const lines =
		b.lines === "contours"
			? linesFromContours(style.overlay.contours)
			: b.lines;
	return (
		<>
			<RampRows
				rows={BAND_RAMPS}
				value={b.ramp}
				onChange={(ramp) => set({ ramp })}
			/>
			<Slider
				label="Band opacity"
				value={b.alpha}
				min={0.05}
				max={1}
				format={pct}
				onChange={(alpha) => set({ alpha })}
			/>
			<Slider
				label="Relief shading"
				value={1 - b.shadeMin}
				min={0}
				max={1}
				format={pct}
				onChange={(v) => set({ shadeMin: 1 - v })}
			/>
			<Slider
				label="Clear the foreground"
				value={b.groundFade[1]}
				min={0}
				max={3000}
				step={50}
				format={metres}
				onChange={(far) =>
					set({ groundFade: [Math.min(b.groundFade[0], far * 0.5), far] })
				}
			/>
			<Group title="Boundaries">
				<ColorSwatch
					label="Colour"
					value={rawHex(b.lineColor)}
					onChange={(lineColor) => set({ lineColor })}
				/>
				<Slider
					label="Strength"
					value={b.lineWhiten}
					min={0}
					max={1}
					format={pct}
					onChange={(lineWhiten) => set({ lineWhiten })}
				/>
				<Slider
					label="Opacity"
					value={b.lineAlpha}
					min={0}
					max={1}
					format={pct}
					onChange={(lineAlpha) => set({ lineAlpha })}
				/>
				<Toggle
					label="Same lines as Contours"
					checked={b.lines === "contours"}
					onChange={(on) =>
						set({
							lines: on
								? "contours"
								: linesFromContours(style.overlay.contours),
						})
					}
				/>
				{b.lines === "contours" ? (
					<p className="text-[10px] leading-snug text-white/35">
						Band height and boundary widths follow the Contours layer. Turn this
						off to set them for bands alone.
					</p>
				) : (
					<LineShape
						v={lines}
						everyLabel="Lines per band"
						onChange={(p) => set({ lines: { ...lines, ...p } })}
					/>
				)}
			</Group>
		</>
	);
}

// ---- slope, ridges, distance tint ---------------------------------------------------------------

type SlopeColors = ViewStyle["overlay"]["slope"]["colors"];
const SLOPE_SETS: [string, SlopeColors][] = [
	[
		"Avalanche (FATMAP)",
		[
			[0.98, 0.86, 0.18],
			[0.97, 0.55, 0.12],
			[0.88, 0.16, 0.16],
			[0.55, 0.22, 0.7],
		],
	],
	["Reds", ["#fcd5b5", "#f59a6b", "#d9412b", "#8c0d1f"]],
	["Blues", ["#c6e3f5", "#79b8e0", "#2f7fc1", "#1b3f8f"]],
	["Greys", ["#e6e6e6", "#b0b0b0", "#707070", "#2e2e2e"]],
];

function SlopeControls({ style }: { style: ViewStyle }) {
	const s = style.overlay.slope;
	const setColor = (i: number, c: Hex) =>
		patch({
			overlay: {
				slope: {
					colors: s.colors.map((x, j) => (j === i ? c : x)) as SlopeColors,
				},
			},
		});
	return (
		<>
			<SwatchRow
				sets={SLOPE_SETS}
				onPick={(colors) => patch({ overlay: { slope: { colors } } })}
			/>
			{["30–35°", "35–40°", "40–45°", "Over 45°"].map((label, i) => (
				<ColorSwatch
					key={label}
					label={label}
					value={hex(s.colors[i])}
					onChange={(c) => setColor(i, c)}
				/>
			))}
			<Slider
				label="Opacity"
				value={s.alpha}
				min={0.1}
				max={1}
				format={pct}
				onChange={(alpha) => patch({ overlay: { slope: { alpha } } })}
			/>
		</>
	);
}

function RidgeControls({ style }: { style: ViewStyle }) {
	const r = style.overlay.ridges;
	const gap = r.threshold[1] - r.threshold[0];
	return (
		<>
			<InkControls style={style} />
			{style.composite.ridges === "classic" && (
				<>
					<ColorSwatch
						label="Inner ridges"
						value={rawHex(r.inner)}
						onChange={(inner) => patch({ overlay: { ridges: { inner } } })}
					/>
					<ColorSwatch
						label="Skyline"
						value={rawHex(r.skyline)}
						onChange={(skyline) => patch({ overlay: { ridges: { skyline } } })}
					/>
					<Slider
						label="Strength"
						value={r.gain}
						min={0}
						max={1}
						format={pct}
						onChange={(gain) => patch({ overlay: { ridges: { gain } } })}
					/>
					<Slider
						label="Detail"
						value={1 - r.threshold[0] / 0.4}
						min={0}
						max={1}
						format={pct}
						onChange={(v) => {
							// lower threshold = more (weaker) ridges drawn
							const lo = Math.max(0.01, 0.4 * (1 - v));
							patch({ overlay: { ridges: { threshold: [lo, lo + gap] } } });
						}}
					/>
				</>
			)}
		</>
	);
}

function DepthTintControls({ style }: { style: ViewStyle }) {
	const d = style.overlay.depthTint;
	const set = (p: DeepPartial<ViewStyle["overlay"]["depthTint"]>) =>
		patch({ overlay: { depthTint: p } });
	return (
		<>
			<RampRows
				rows={TINT_RAMPS}
				value={d.ramp}
				onChange={(ramp) => set({ ramp })}
			/>
			<Slider
				label="Nearest colour at"
				value={d.nearM}
				min={50}
				max={5000}
				step={50}
				format={metres}
				onChange={(nearM) => set({ nearM, farM: Math.max(d.farM, nearM * 4) })}
			/>
			<Slider
				label="Farthest colour at"
				value={d.farM}
				min={5000}
				max={200000}
				step={1000}
				format={km}
				onChange={(farM) => set({ farM })}
			/>
			<Slider
				label="Strength"
				value={d.gain}
				min={0}
				max={1}
				format={pct}
				onChange={(gain) => set({ gain })}
			/>
			<Slider
				label="Keep photo detail"
				value={d.lumaKeep[1]}
				min={0}
				max={1}
				format={pct}
				onChange={(b) => set({ lumaKeep: [1 - b, b] })}
			/>
		</>
	);
}

/** Ink lines (look composite): anti-aliased silhouettes that fade with distance, plus creases. */
function InkControls({ style }: { style: ViewStyle }) {
	const k = style.composite.ink;
	return (
		<>
			<Toggle
				label="Ink lines"
				checked={style.composite.ridges === "ink"}
				onChange={(on) =>
					patch({ composite: { ridges: on ? "ink" : "classic" } })
				}
			/>
			{style.composite.ridges === "ink" && (
				<>
					<Slider
						label="Ink strength"
						value={k.strength}
						min={0}
						max={1}
						onChange={(strength) => patch({ composite: { ink: { strength } } })}
					/>
					<Slider
						label="Ink width"
						value={k.width}
						min={0.5}
						max={3}
						step={0.1}
						format={(v) => `×${v.toFixed(1)}`}
						onChange={(width) => patch({ composite: { ink: { width } } })}
					/>
					<Slider
						label="Creases"
						value={k.crease}
						min={0}
						max={1}
						onChange={(crease) => patch({ composite: { ink: { crease } } })}
					/>
					<Slider
						label="Pencil wobble"
						value={style.composite.sketch ?? 0}
						min={0}
						max={1}
						format={(v) => (v ? pct(v) : "off")}
						onChange={(sketch) => patch({ composite: { sketch } })}
					/>
					<ColorSwatch
						label="Ink"
						value={rawHex(k.inner)}
						onChange={(inner) => patch({ composite: { ink: { inner } } })}
					/>
					<ColorSwatch
						label="Skyline ink"
						value={rawHex(k.skyline)}
						onChange={(skyline) => patch({ composite: { ink: { skyline } } })}
					/>
				</>
			)}
		</>
	);
}

// ---- layer definitions --------------------------------------------------------------------------

const INK_PATHS: Path[] = [
	["composite", "ridges"],
	["composite", "ink"],
	["composite", "sketch"],
];

const L = {
	contours: {
		id: "contours",
		title: "Contours",
		paths: [["overlay", "contours"]],
	},
	bands: {
		id: "bands",
		title: "Elevation bands",
		paths: [["overlay", "bands"]],
		// a preset's bands with its contour-following boundaries made explicit, so the copy looks the
		// same whatever the contours are doing
		copy: (p) => ({
			overlay: {
				bands: {
					...p.overlay.bands,
					lines:
						p.overlay.bands.lines === "contours"
							? linesFromContours(p.overlay.contours)
							: p.overlay.bands.lines,
				},
			},
		}),
	},
	slope: { id: "slope", title: "Slope angle", paths: [["overlay", "slope"]] },
	ridges: {
		id: "ridges",
		title: "Ridgelines",
		paths: [["overlay", "ridges"], ...INK_PATHS],
	},
	depthTint: {
		id: "depth-tint",
		title: "Distance tint",
		paths: [["overlay", "depthTint"]],
	},
	relief: { id: "relief", title: "Relief map", paths: [["terrain"]] },
	replaceImagery: {
		id: "replace-imagery",
		title: "Map colours",
		paths: [["replace", "imagery"]],
	},
	replaceHaze: {
		id: "replace-haze",
		title: "Haze",
		paths: [
			["replace", "haze"],
			["terrain", "hazeColor"],
		],
	},
	edges: {
		id: "edges",
		title: "Edges and ink",
		paths: [["replace", "hairline"], ["replace", "ridges"], ...INK_PATHS],
	},
	blend: {
		id: "blend",
		title: "Blend with the photo",
		paths: [
			["composite", "refine"],
			["composite", "harmonize"],
			["composite", "output"],
		],
	},
	sky: { id: "sky", title: "Sky", paths: [["world", "sky"]] },
	worldHaze: {
		id: "world-haze",
		title: "Haze",
		paths: [
			["world", "haze"],
			["terrain", "hazeColor"],
		],
	},
	worldImagery: {
		id: "world-imagery",
		title: "Map colours",
		paths: [["world", "imagery"]],
	},
	drape: {
		id: "drape",
		title: "Photo drape",
		paths: [
			["world", "drapeHarmonize"],
			["world", "clearAir"],
			["world", "projectionTint"],
		],
	},
	frame: { id: "frame", title: "Photo frame", paths: [["world", "frame"]] },
	waterWind: {
		id: "water-wind",
		title: "Water and wind",
		paths: [
			["world", "water"],
			["world", "wind"],
		],
	},
	labels: { id: "labels", title: "Label style", paths: [["labels"]] },
	trails: { id: "trails", title: "Trail style", paths: [["trails"]] },
} satisfies Record<string, LayerDef>;

// ---- per-view layer lists -----------------------------------------------------------------------

type ViewProps = { settings: Settings; style: ViewStyle; state: StyleState };

function OverlayLayers({ settings, style, state }: ViewProps) {
	const o = settings.overlayStyle;
	return (
		<>
			<LayerCard def={L.contours} active={o === "contours"} state={state}>
				<ContourControls style={style} />
			</LayerCard>
			<LayerCard def={L.bands} active={o === "bands"} state={state}>
				<BandControls style={style} which="overlay" />
			</LayerCard>
			<LayerCard def={L.slope} active={o === "slope"} state={state}>
				<SlopeControls style={style} />
			</LayerCard>
			<LayerCard def={L.ridges} active={settings.ridges > 0} state={state}>
				<RidgeControls style={style} />
			</LayerCard>
			<LayerCard
				def={L.depthTint}
				active={settings.depthTint > 0}
				state={state}
			>
				<DepthTintControls style={style} />
			</LayerCard>
		</>
	);
}

function ReplaceLayers({ settings, style, state }: ViewProps) {
	const m = settings.mapStyle;
	const imagery = m === "satellite" || m === "topo";
	const h = style.replace.hairline;
	const c = style.composite;
	return (
		<>
			<LayerCard def={L.replaceImagery} active={imagery} state={state}>
				<ImageryGroup which="replace" style={style} />
			</LayerCard>
			<LayerCard def={L.relief} active={m === "hillshade"} state={state}>
				<ReliefGroup style={style} />
			</LayerCard>
			<LayerCard def={L.bands} active={m === "bands"} state={state}>
				<BandControls style={style} which="replace" />
			</LayerCard>
			<LayerCard def={L.replaceHaze} state={state}>
				<HazeGroup which="replace" style={style} />
			</LayerCard>
			<LayerCard def={L.edges} state={state}>
				<ColorSwatch
					label="Mask hairline"
					value={rawHex(h.color)}
					onChange={(color) => patch({ replace: { hairline: { color } } })}
				/>
				<Slider
					label="Hairline opacity"
					value={h.alpha}
					min={0}
					max={1}
					format={pct}
					onChange={(alpha) => patch({ replace: { hairline: { alpha } } })}
				/>
				<ColorSwatch
					label="Ridge accent"
					value={rawHex(style.replace.ridges.inner)}
					onChange={(inner) => patch({ replace: { ridges: { inner } } })}
				/>
				<Slider
					label="Ridge accent strength"
					value={style.replace.ridges.gain}
					min={0}
					max={1}
					format={pct}
					onChange={(gain) => patch({ replace: { ridges: { gain } } })}
				/>
				<InkControls style={style} />
			</LayerCard>
			<LayerCard def={L.blend} state={state}>
				<Toggle
					label="Snap to the photo's edges"
					checked={c.refine}
					onChange={(refine) => patch({ composite: { refine } })}
				/>
				<Slider
					label="Match the photo's colours"
					value={c.harmonize}
					min={0}
					max={1}
					onChange={(harmonize) => patch({ composite: { harmonize } })}
				/>
				<Toggle
					label="Photo tone and grain"
					checked={c.output === "neutral"}
					onChange={(on) =>
						patch({ composite: { output: on ? "neutral" : "classic" } })
					}
				/>
			</LayerCard>
		</>
	);
}

function WorldLayers({ settings, style, state }: ViewProps) {
	const w = style.world;
	const relief = settings.worldStyle === "hillshade";
	return (
		<>
			<LayerCard def={L.sky} state={state}>
				<Segmented
					size="sm"
					value={w.sky.mode}
					onChange={(mode) => patch({ world: { sky: { mode } } })}
					options={[
						{ value: "flat", label: "Flat colour" },
						{ value: "atmosphere", label: "Atmosphere" },
					]}
				/>
				{w.sky.mode === "flat" && (
					<ColorSwatch
						label="Sky"
						value={hex(w.sky.background)}
						onChange={(c) =>
							patch({ world: { sky: { background: c, clear: c } } })
						}
					/>
				)}
			</LayerCard>
			<LayerCard def={L.worldHaze} state={state}>
				<HazeGroup which="world" style={style} />
			</LayerCard>
			<LayerCard def={L.worldImagery} active={!relief} state={state}>
				<ImageryGroup which="world" style={style} />
			</LayerCard>
			<LayerCard def={L.relief} active={relief} state={state}>
				<ReliefGroup style={style} />
			</LayerCard>
			<LayerCard def={L.drape} state={state}>
				<Slider
					label="Tone the map to the photo"
					value={w.drapeHarmonize}
					min={0}
					max={1}
					onChange={(drapeHarmonize) => patch({ world: { drapeHarmonize } })}
				/>
				{/* look/clear-air: the photo's own haze off the drape, so far ground isn't veiled twice */}
				<Segmented
					size="sm"
					value={w.clearAir.mode}
					onChange={(mode) => patch({ world: { clearAir: { mode } } })}
					options={[
						{ value: "off", label: "Hazy" },
						{ value: "consistent", label: "No double haze" },
						{ value: "fitted", label: "Clear air" },
					]}
				/>
				{w.clearAir.mode !== "off" && (
					<Slider
						label="Haze removed"
						value={w.clearAir.amount}
						min={0}
						max={1}
						format={pct}
						onChange={(amount) => patch({ world: { clearAir: { amount } } })}
					/>
				)}
				<ColorSwatch
					label="Projection tint"
					value={rawHex(w.projectionTint.color)}
					onChange={(color) => patch({ world: { projectionTint: { color } } })}
				/>
				<Slider
					label="Tint amount"
					value={w.projectionTint.amount}
					min={0}
					max={1}
					format={pct}
					onChange={(amount) =>
						patch({ world: { projectionTint: { amount } } })
					}
				/>
			</LayerCard>
			<LayerCard def={L.frame} state={state}>
				<ColorSwatch
					label="Frame lines"
					value={hex(w.frame.lineColor)}
					onChange={(lineColor) => patch({ world: { frame: { lineColor } } })}
				/>
				<Slider
					label="Line opacity"
					value={w.frame.lineOpacity}
					min={0}
					max={1}
					format={pct}
					onChange={(lineOpacity) =>
						patch({ world: { frame: { lineOpacity } } })
					}
				/>
				<Slider
					label="Photo opacity"
					value={w.frame.planeOpacity}
					min={0}
					max={1}
					format={pct}
					onChange={(planeOpacity) =>
						patch({ world: { frame: { planeOpacity } } })
					}
				/>
				<ColorSwatch
					label="Camera pin"
					value={hex(w.frame.pinColor)}
					onChange={(pinColor) => patch({ world: { frame: { pinColor } } })}
				/>
				<Slider
					label="Pin size"
					value={w.frame.pinRadiusM}
					min={5}
					max={60}
					step={1}
					format={(v) => `${Math.round(v)} m`}
					onChange={(pinRadiusM) => patch({ world: { frame: { pinRadiusM } } })}
				/>
			</LayerCard>
			<LayerCard def={L.waterWind} state={state}>
				<WaterWindControls style={style} />
			</LayerCard>
		</>
	);
}

/** Lake waves (needs the alpine water albedo) and wind-drift particles (WebGPU world view only). */
function WaterWindControls({ style }: { style: ViewStyle }) {
	const w = style.world.wind;
	const patchWind = (p: DeepPartial<ViewStyle["world"]["wind"]>) =>
		patch({ world: { wind: p } });
	return (
		<>
			<Toggle
				label="Lake waves"
				checked={style.world.water === "waves"}
				onChange={(on) => patch({ world: { water: on ? "waves" : "flat" } })}
			/>
			<Toggle
				label="Wind particles (WebGPU)"
				checked={w.on}
				onChange={(on) => patchWind({ on })}
			/>
			{w.on && (
				<>
					<Slider
						label="Wind from"
						value={w.direction}
						min={0}
						max={359}
						step={1}
						format={(v) => `${Math.round(v)}°`}
						onChange={(direction) => patchWind({ direction })}
					/>
					<Slider
						label="Wind speed"
						value={w.speed}
						min={1}
						max={40}
						step={1}
						format={(v) => `${Math.round(v)} m/s`}
						onChange={(speed) => patchWind({ speed })}
					/>
					<Slider
						label="Particle density"
						value={w.density}
						min={0}
						max={1}
						format={pct}
						onChange={(density) => patchWind({ density })}
					/>
				</>
			)}
		</>
	);
}

// ---- the panel ----------------------------------------------------------------------------------

export function StylePanel({
	mode,
	settings,
	style,
	state,
}: {
	mode: Mode;
	settings: Settings;
	style: ViewStyle;
	state: StyleState;
}) {
	const custom = Object.keys(state.overrides).length > 0;
	const store = getStyleStore();
	const props = { settings, style, state };
	return (
		<Section
			title="Look"
			collapse={{ id: "look" }}
			summary={PRESET_LABELS[state.preset]}
			aside={
				custom ? (
					<span
						className="flex items-center gap-1 text-[10px] text-white/45"
						title="Some layers are styled differently from the theme"
					>
						<span className="size-1.5 rounded-full bg-cyan-400" /> customised
					</span>
				) : undefined
			}
		>
			<Group title="Theme · sets every layer">
				<PresetChips value={state.preset} />
			</Group>
			<Group title="Layers">
				<div className="space-y-1.5">
					{mode === "overlay" && <OverlayLayers {...props} />}
					{mode === "replace" && <ReplaceLayers {...props} />}
					{mode === "world" && <WorldLayers {...props} />}
				</div>
			</Group>
			<Button
				onClick={() => store.resetOverrides()}
				disabled={!custom}
				className="w-full"
			>
				Reset every layer to {PRESET_LABELS[state.preset]}
			</Button>
			{store.urlOverride && (
				<p className="text-[10px] leading-snug text-white/35">
					Preset set by the page address (?style=): changes are not saved.
				</p>
			)}
		</Section>
	);
}

/** Labels are edited on screen; export then follows the screen metrics (export: null). */
const patchLabels = (p: DeepPartial<LabelStyle>) =>
	patch({ labels: { ...p, export: null } });

export function LabelStylePanel({ style }: { style: ViewStyle }) {
	const state = getStyleStore().getState();
	const l = style.labels;
	const halo = l.halo.kind;
	return (
		<LayerCard def={L.labels} state={state}>
			<Segmented
				size="sm"
				value={l.layout}
				onChange={(layout) => patch({ labels: { layout } })}
				options={[
					{ value: "classic", label: "Classic" },
					{
						value: "panorama",
						label: "Panorama",
						title: "Leaders up to a band above the skyline, rotated names",
					},
					{
						value: "inline",
						label: "Inline",
						title: "Names beside the summits",
					},
				]}
			/>
			<Slider
				label="Text size"
				value={l.name.px}
				min={9}
				max={18}
				step={1}
				format={(v) => `${v} px`}
				onChange={(px) =>
					patchLabels({
						name: { px },
						sub: { px: Math.max(8, Math.round((px * 10) / 12)) },
					})
				}
			/>
			<Row label="Weight">
				<Segmented
					size="sm"
					value={String(l.name.weight)}
					onChange={(w) => patchLabels({ name: { weight: Number(w) } })}
					options={[
						{ value: "400", label: "Reg" },
						{ value: "600", label: "Semi" },
						{ value: "800", label: "Bold" },
					]}
				/>
			</Row>
			<ColorSwatch
				label="Text colour"
				value={hex(l.name.color)}
				onChange={(color) =>
					patchLabels({ name: { color }, sub: { color: `${color}bf` as Hex } })
				}
			/>
			<Segmented
				size="sm"
				value={l.sub.show}
				onChange={(show) => patchLabels({ sub: { show } })}
				options={[
					{ value: "ele+dist", label: "Ele · km" },
					{ value: "ele", label: "Ele" },
					{ value: "dist", label: "km" },
					{ value: "none", label: "Name" },
				]}
			/>
			<Segmented
				size="sm"
				value={halo}
				onChange={(kind) =>
					patchLabels({
						halo:
							kind === "stroke"
								? { kind, strokePx: l.halo.strokePx || 3, color: l.halo.color }
								: kind === "shadow"
									? { kind, blurPx: l.halo.blurPx || 3, color: l.halo.color }
									: { kind },
					})
				}
				options={[
					{ value: "shadow", label: "Shadow" },
					{ value: "stroke", label: "Outline" },
					{ value: "none", label: "No halo" },
				]}
			/>
			{halo !== "none" && (
				<>
					<ColorSwatch
						label="Halo colour"
						value={hex(l.halo.color)}
						onChange={(c) => patchLabels({ halo: { color: `${c}e6` as Hex } })}
					/>
					{halo === "shadow" ? (
						<Slider
							label="Shadow blur"
							value={l.halo.blurPx}
							min={0}
							max={8}
							step={0.5}
							format={(v) => `${v} px`}
							onChange={(blurPx) => patchLabels({ halo: { blurPx } })}
						/>
					) : (
						<Slider
							label="Outline width"
							value={l.halo.strokePx}
							min={1}
							max={6}
							step={0.5}
							format={(v) => `${v} px`}
							onChange={(strokePx) => patchLabels({ halo: { strokePx } })}
						/>
					)}
				</>
			)}
			<Slider
				label="Leader length"
				value={l.leader.lengthPx}
				min={0}
				max={60}
				step={1}
				format={(v) => (v ? `${v} px` : "off")}
				onChange={(lengthPx) => patchLabels({ leader: { lengthPx } })}
			/>
			{l.leader.lengthPx > 0 && (
				<ColorSwatch
					label="Leader colour"
					value={hex(l.leader.color)}
					onChange={(c) => patchLabels({ leader: { color: `${c}e6` as Hex } })}
				/>
			)}
			<Slider
				label="Dot size"
				value={l.dot.px}
				min={0}
				max={12}
				step={1}
				format={(v) => (v ? `${v} px` : "off")}
				onChange={(px) => patchLabels({ dot: { px } })}
			/>
			{l.dot.px > 0 && (
				<ColorSwatch
					label="Dot colour"
					value={hex(l.dot.color)}
					onChange={(color) => patchLabels({ dot: { color } })}
				/>
			)}
			<Toggle
				label="Glowing summit markers"
				checked={!!l.glow}
				onChange={(on) =>
					patch({ labels: { glow: on ? { ...GLOW_DEFAULT } : null } })
				}
			/>
			{l.glow && (
				<>
					<Slider
						label="Glow radius"
						value={l.glow.radiusPx}
						min={8}
						max={60}
						step={1}
						format={(v) => `${Math.round(v)} px`}
						onChange={(radiusPx) => patch({ labels: { glow: { radiusPx } } })}
					/>
					<Slider
						label="Glow intensity"
						value={l.glow.intensity}
						min={0}
						max={2}
						onChange={(intensity) => patch({ labels: { glow: { intensity } } })}
					/>
					<ColorSwatch
						label="Glow tint"
						value={hex(l.glow.tint)}
						onChange={(tint) => patch({ labels: { glow: { tint } } })}
					/>
				</>
			)}
			<Slider
				label="Max labels"
				value={l.maxLabels}
				min={5}
				max={40}
				step={1}
				format={(v) => String(v)}
				onChange={(maxLabels) => patchLabels({ maxLabels })}
			/>
		</LayerCard>
	);
}

const TRAIL_CLASSES = [
	["hiking", "Hiking (T1–T2)"],
	["mountain", "Mountain (T3–T4)"],
	["alpine", "Alpine (T5–T6)"],
	["other", "Other paths"],
] as const;

export function TrailStylePanel({ style }: { style: ViewStyle }) {
	const state = getStyleStore().getState();
	const t = style.trails;
	return (
		<LayerCard def={L.trails} state={state}>
			<Slider
				label="Trail width"
				value={t.width}
				min={1}
				max={5}
				step={0.1}
				format={(v) => `${v.toFixed(1)} px`}
				onChange={(width) => patch({ trails: { width } })}
			/>
			<Slider
				label="Trail opacity"
				value={t.opacity}
				min={0.3}
				max={1}
				format={pct}
				onChange={(opacity) => patch({ trails: { opacity } })}
			/>
			<Segmented
				size="sm"
				value={t.stroke ?? "solid"}
				onChange={(stroke) => patch({ trails: { stroke } })}
				options={[
					{ value: "solid", label: "Solid" },
					{ value: "pencil", label: "Pencil" },
					{ value: "glow", label: "Glow" },
				]}
			/>
			{TRAIL_CLASSES.map(([k, label]) => (
				<ColorSwatch
					key={k}
					label={label}
					value={hex(t.colors[k])}
					onChange={(c) => patch({ trails: { colors: { [k]: c } } })}
				/>
			))}
		</LayerCard>
	);
}
