// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// T3.1 "Read this view" place card + T3.3 line-of-sight profile. Tap (not drag) the photo: the card
// reads the terrain under the pixel through the geometry buffer (elevation, range, slope, aspect), the
// pack (cover class, lithology, glacier extents, nearest names) and the capture-time sun (does the
// slope face it). Display-only: nothing here feeds pose, matching or measurements.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BRAND } from "#/brand/khipu";
import { sunPosition } from "#/lib/look/sun";
import { coverInfo } from "../classes";
import type { NameClass, TerroirName } from "../types";
import {
	approxDistM,
	aspectWord,
	formatDist,
	pointInMulti,
	sunIncidenceDeg,
	surfaceNormal,
	type Vec3,
} from "../viz/geo";
import { FONT } from "../viz/ink";
import type { Profile } from "../viz/profile";
import { demProfile, surfaceProfile } from "../viz/profile";
import type { TerroirCtx } from "./context";

const CARD_W = 264;
const CLS_LABEL: Partial<Record<NameClass, string>> = {
	"peak-major": "peak",
	"peak-minor": "summit",
	peak: "peak",
	alp: "alp",
	hut: "hut",
	pass: "pass",
	lake: "lake",
	river: "river",
	valley: "valley",
	ridge: "ridge",
	massif: "massif",
	glacier: "glacier",
	town: "town",
	city: "city",
	village: "village",
	hamlet: "hamlet",
	waterfall: "waterfall",
	region: "region",
	field: "field name",
	lift: "lift",
};
const LANG: Record<string, string> = {
	de: "German",
	fr: "French",
	it: "Italian",
	rm: "Romansh",
	multi: "multilingual",
};

type Info = {
	lat: number;
	lon: number;
	h: number;
	range: number;
	slope: number | null;
	aspect: number | null;
	coverId: number;
	litNote: string | null;
	litYes: boolean | null;
	lithology: string | null;
	glacier: string | null;
	names: { n: TerroirName; dist: number }[];
	on: string | null;
	u: number;
	v: number;
};

function nameLine(n: TerroirName) {
	const parts = [CLS_LABEL[n.cls] ?? n.cls];
	if (n.status)
		parts.push(
			n.status === "official"
				? "official"
				: n.status === "usual"
					? "usual form"
					: "informal",
		);
	let s = `${n.name} · ${parts.join(" · ")}`;
	if (n.lang) s += ` (${n.lang})`;
	return s;
}

function readView(ctx: TerroirCtx, u: number, v: number): Info | null {
	const eng = ctx.engine;
	const s = eng.sampleAt(u, v);
	if (!s) return null;
	const du = 3 / ctx.w;
	const dv = 3 / ctx.h;
	const nb = [
		eng.sampleAt(u - du, v),
		eng.sampleAt(u + du, v),
		eng.sampleAt(u, v - dv),
		eng.sampleAt(u, v + dv),
	];
	let slope: number | null = null;
	let aspect: number | null = null;
	let normal: Vec3 | null = null;
	// a depth jump (silhouette) between the neighbours makes the normal meaningless
	if (nb.every((x) => x && Math.abs(x.range - s.range) < 0.06 * s.range + 20)) {
		const r = surfaceNormal(
			(nb[0] as { world: Vec3 }).world,
			(nb[1] as { world: Vec3 }).world,
			(nb[2] as { world: Vec3 }).world,
			(nb[3] as { world: Vec3 }).world,
		);
		if (r) {
			slope = r.slope;
			aspect = r.aspect;
			normal = r.normal;
		}
	}
	const coverId = ctx.cover?.at(s.lat, s.lon) ?? 0;
	const pack = ctx.pack;

	let litNote: string | null = null;
	let litYes: boolean | null = null;
	const at = ctx.takenAt ?? eng.photo.takenAt;
	if (at && normal) {
		const sun = sunPosition(new Date(at), eng.photo.lat, eng.photo.lon);
		if (sun.elevation <= 0) {
			litNote = "sun below the horizon at capture";
			litYes = false;
		} else {
			const inc = sunIncidenceDeg(normal, sun.dir);
			litYes = inc < 90;
			litNote = litYes
				? `faces the sun at capture (${Math.round(inc)}° off the normal)`
				: "turned from the sun at capture";
		}
	}

	let lithology: string | null = null;
	let glacier: string | null = null;
	let names: Info["names"] = [];
	let on: string | null = null;
	if (pack) {
		lithology =
			pack.lithology?.find((l) => pointInMulti(s.lon, s.lat, l.polygons))
				?.label ?? null;
		const exts = [...pack.glaciers].sort((a, b) => a.year - b.year);
		if (exts.length) {
			const inside = exts.filter((e) => pointInMulti(s.lon, s.lat, e.polygons));
			const latest = exts[exts.length - 1];
			if (inside.length) {
				const oldest = inside[0];
				const stillIce = inside.includes(latest);
				glacier =
					stillIce && oldest === latest
						? `Glacier ice in ${latest.year}`
						: stillIce
							? `Inside the ${oldest.year} extent, still ice in ${latest.year}`
							: `Inside the ${oldest.year} extent, ice-free in ${latest.year}`;
			} else if (coverId === 1 || coverId === 2)
				glacier = "Glacier or firn in the land-cover data";
		}
		names = pack.names
			.map((n) => ({ n, dist: approxDistM(s.lat, s.lon, n.lat, n.lon) }))
			.filter((x) => x.dist <= 1000)
			.sort((a, b) => a.dist - b.dist)
			.slice(0, 3);
		if (coverId === 12) {
			const lake = pack.names
				.filter((n) => n.cls === "lake")
				.map((n) => ({ n, dist: approxDistM(s.lat, s.lon, n.lat, n.lon) }))
				.sort((a, b) => a.dist - b.dist)[0];
			if (lake && lake.dist < 25000) on = lake.n.name;
		}
	}
	return {
		lat: s.lat,
		lon: s.lon,
		h: s.h,
		range: s.range,
		slope,
		aspect,
		coverId,
		litNote,
		litYes,
		lithology,
		glacier,
		names,
		on,
		u,
		v,
	};
}

function ProfileChart({
	profile,
	eyeAlt,
	target,
}: {
	profile: Profile;
	eyeAlt: number;
	target: number;
}) {
	const W = 240;
	const H = 76;
	const pad = { l: 4, r: 4, t: 6, b: 14 };
	const pts = profile.pts;
	const dMax = Math.max(pts[pts.length - 1].d, 1);
	const hs = pts.map((p) => p.h);
	const lo = Math.min(...hs) - 20;
	const hi = Math.max(...hs, eyeAlt, target) + 20;
	const x = (d: number) => pad.l + (d / dMax) * (W - pad.l - pad.r);
	const y = (m: number) =>
		pad.t + (1 - (m - lo) / (hi - lo)) * (H - pad.t - pad.b);
	const line = pts
		.map((p, i) => `${i ? "L" : "M"}${x(p.d).toFixed(1)} ${y(p.h).toFixed(1)}`)
		.join("");
	const base = H - pad.b;
	return (
		<svg
			width={W}
			height={H}
			viewBox={`0 0 ${W} ${H}`}
			role="img"
			aria-label="Line-of-sight profile"
		>
			{pts.slice(1).map((p, i) => {
				const q = pts[i];
				return (
					<path
						key={p.d}
						d={`M${x(q.d)} ${y(q.h)}L${x(p.d)} ${y(p.h)}V${base}H${x(q.d)}Z`}
						fill={coverInfo(p.cover).color}
						fillOpacity={p.cover ? 0.85 : 0.25}
						stroke={coverInfo(p.cover).color}
						strokeOpacity={p.cover ? 0.85 : 0.25}
						strokeWidth={0.6}
					/>
				);
			})}
			<path
				d={line}
				fill="none"
				stroke={BRAND.paper}
				strokeWidth={1.2}
				strokeLinejoin="round"
			/>
			{profile.kind === "profile" && (
				<path
					d={`M${x(0)} ${y(eyeAlt)}L${x(dMax)} ${y(target)}`}
					stroke={BRAND.glow}
					strokeWidth={1}
					strokeDasharray="3 3"
				/>
			)}
			<circle
				cx={x(pts[pts.length - 1].d)}
				cy={y(pts[pts.length - 1].h)}
				r={2.6}
				fill={BRAND.glow}
			/>
			<text
				x={pad.l}
				y={H - 3}
				fontSize={8.5}
				fill={BRAND.paper}
				fillOpacity={0.6}
			>
				{Math.round(Math.min(...hs))} m
			</text>
			<text
				x={W - pad.r}
				y={H - 3}
				fontSize={8.5}
				textAnchor="end"
				fill={BRAND.paper}
				fillOpacity={0.6}
			>
				{formatDist(dMax)} · {Math.round(Math.max(...hs))} m peak
			</text>
		</svg>
	);
}

const row = "grid grid-cols-[64px_1fr] gap-x-2 text-[11px] leading-snug";
const k = "text-white/45";

const poseKey = (c: TerroirCtx) => {
	const p = c.engine.pose;
	return `${p.yaw.toFixed(2)}|${p.pitch.toFixed(2)}|${p.roll.toFixed(2)}|${p.vfov.toFixed(2)}`;
};

export function PlaceCard({ ctx }: { ctx: TerroirCtx }) {
	const { stageEl, w, h } = ctx;
	const [card, setCard] = useState<{
		x: number;
		y: number;
		info: Info;
		pose: string;
	} | null>(null);
	const [profile, setProfile] = useState<Profile | null | "loading">("loading");
	const [size, setSize] = useState({ w: CARD_W, h: 300 });
	const ref = useRef<HTMLDivElement>(null);
	const ctxRef = useRef(ctx);
	ctxRef.current = ctx;

	useEffect(() => {
		if (!stageEl) return;
		let down: { x: number; y: number } | null = null;
		const onDown = (e: PointerEvent) => {
			down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
		};
		const onUp = (e: PointerEvent) => {
			const d = down;
			down = null;
			if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
			const t = e.target as HTMLElement | null;
			if (
				t?.closest(
					"[data-place-card],button,a,input,select,textarea,[role=button]",
				)
			)
				return;
			const c = ctxRef.current;
			const r = stageEl.getBoundingClientRect();
			if (!r.width || !r.height) return;
			const px = e.clientX - r.left;
			const py = e.clientY - r.top;
			const info = readView(c, px / r.width, py / r.height);
			if (!info) {
				setCard(null);
				return;
			}
			setProfile("loading");
			setCard({
				x: (px / r.width) * c.w,
				y: (py / r.height) * c.h,
				info,
				pose: poseKey(c),
			});
		};
		stageEl.addEventListener("pointerdown", onDown, true);
		stageEl.addEventListener("pointerup", onUp, true);
		return () => {
			stageEl.removeEventListener("pointerdown", onDown, true);
			stageEl.removeEventListener("pointerup", onUp, true);
		};
	}, [stageEl]);

	// the card describes one pose: close it when the view moves
	// biome-ignore lint/correctness/useExhaustiveDependencies: ctx.frame is the pose tick
	useEffect(() => {
		if (card && poseKey(ctx) !== card.pose) setCard(null);
	}, [ctx.frame]);

	const cardInfo = card?.info;
	useEffect(() => {
		if (!cardInfo) return;
		const stop = { aborted: false };
		const c = ctxRef.current;
		const photo = c.engine.photo;
		(async () => {
			let p = await demProfile(photo, cardInfo, c.cover, stop);
			if (stop.aborted) return;
			p ??= surfaceProfile(
				(u, v) => c.engine.sampleAt(u, v),
				c.cover,
				cardInfo.u,
				cardInfo.v,
			);
			if (!stop.aborted) setProfile(p);
		})();
		return () => {
			stop.aborted = true;
		};
	}, [cardInfo]);

	useLayoutEffect(() => {
		const el = ref.current;
		if (el && (el.offsetHeight !== size.h || el.offsetWidth !== size.w))
			setSize({ w: el.offsetWidth, h: el.offsetHeight });
	});

	const pos = useMemo(() => {
		if (!card) return null;
		const left =
			card.x + 16 + size.w > w - 8 ? card.x - 16 - size.w : card.x + 16;
		return {
			left: Math.max(8, Math.min(w - size.w - 8, left)),
			top: Math.max(8, Math.min(h - size.h - 8, card.y - 24)),
		};
	}, [card, size, w, h]);

	if (!card || !pos) return null;
	const i = card.info;
	const cov = i.coverId ? coverInfo(i.coverId) : null;
	const lead = i.names[0];
	return (
		<>
			<div
				className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[var(--rigi-glow)]"
				style={{ left: card.x, top: card.y }}
			/>
			<div
				ref={ref}
				data-place-card
				className="pointer-events-auto absolute rounded-lg bg-black/70 p-3 text-white/90 shadow-lg ring-1 ring-white/10 backdrop-blur"
				style={{
					left: pos.left,
					top: pos.top,
					width: CARD_W,
					fontFamily: FONT,
				}}
			>
				<div className="mb-1.5 flex items-start justify-between gap-2">
					<div className="text-[13px] font-bold leading-tight">
						{lead ? lead.n.name : i.on ? `On ${i.on}` : "This spot"}
						{lead && lead.dist > 150 && (
							<span className="ml-1 text-[10px] font-medium text-white/50">
								{formatDist(lead.dist)} away
							</span>
						)}
					</div>
					<button
						type="button"
						aria-label="Close"
						onClick={() => setCard(null)}
						className="-mr-1 -mt-0.5 px-1 text-[15px] leading-none text-white/50 hover:text-white"
					>
						×
					</button>
				</div>
				{lead && (
					<div className="mb-2 text-[10.5px] text-white/60">
						{nameLine(lead.n)}
						{lead.n.lang ? ` · ${LANG[lead.n.lang]}` : ""}
					</div>
				)}
				<div className="space-y-1">
					<div className={row}>
						<span className={k}>Elevation</span>
						<span>
							{Math.round(i.h)} m · {formatDist(i.range)} from the camera
						</span>
					</div>
					{i.slope != null && i.aspect != null && (
						<div className={row}>
							<span className={k}>Slope</span>
							<span>
								{Math.round(i.slope)}° · faces {aspectWord(i.aspect)} (
								{Math.round(i.aspect)}°)
							</span>
						</div>
					)}
					{cov && (
						<div className={row}>
							<span className={k}>Cover</span>
							<span className="flex items-center gap-1.5">
								<span
									className="inline-block h-2.5 w-2.5 rounded-[2px] ring-1 ring-white/20"
									style={{ background: cov.color }}
								/>
								{cov.label}
							</span>
						</div>
					)}
					{i.lithology && (
						<div className={row}>
							<span className={k}>Rock</span>
							<span>{i.lithology}</span>
						</div>
					)}
					{i.glacier && (
						<div className={row}>
							<span className={k}>Ice</span>
							<span>{i.glacier}</span>
						</div>
					)}
					{i.litNote && (
						<div className={row}>
							<span className={k}>Light</span>
							<span>{i.litNote}</span>
						</div>
					)}
					{i.names.length > 1 && (
						<div className={row}>
							<span className={k}>Near</span>
							<span className="text-white/75">
								{i.names
									.slice(1)
									.map((n) => `${n.n.name} (${formatDist(n.dist)})`)
									.join(", ")}
							</span>
						</div>
					)}
				</div>
				<div className="mt-2.5 border-t border-white/10 pt-2">
					<div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-white/45">
						{profile && profile !== "loading" && profile.kind === "surface"
							? "Visible surface"
							: "Line of sight"}
					</div>
					{profile === "loading" && (
						<div className="text-[10.5px] text-white/40">
							Reading the terrain…
						</div>
					)}
					{profile && profile !== "loading" && (
						<ProfileChart
							profile={profile}
							eyeAlt={ctx.engine.eyeAlt || ctx.engine.demAtCamera}
							target={i.h}
						/>
					)}
					{profile === null && (
						<div className="text-[10.5px] text-white/40">
							No profile available.
						</div>
					)}
				</div>
			</div>
		</>
	);
}
