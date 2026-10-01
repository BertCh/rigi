// The one mount point for terroir overlays in PhotoWorkspace (reports/terroir-cartography.md).
// Purely additive: with every style.terroir switch off (CLASSIC and every preset but `terroir`) it
// renders nothing and loads nothing. It finds the terroir pack by the photo's location, re-renders
// on engine frames (rAF-throttled) and hands each overlay a TerroirCtx.
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { Renderer } from "#/lib/renderer";
import type { ViewStyle } from "#/lib/style/types";
import { type CoverGrid, findPack, loadCover } from "../pack";
import type { TerroirPack } from "../types";
import type { TerroirCtx } from "./context";
import { Furniture } from "./Furniture";
import { GlacierGhost } from "./GlacierGhost";
import { Legend } from "./Legend";
import { NamesSvg } from "./NamesSvg";
import { PlaceCard } from "./PlaceCard";
import { SunPath } from "./SunPath";

/** Any terroir layer on? (cheap; decides whether the pack is fetched at all) */
export function terroirActive(style: ViewStyle) {
	const t = style.terroir;
	return (
		t.names.on ||
		t.peakTiers ||
		t.contours.inkByCover ||
		t.cover.on ||
		t.glacier.on ||
		t.sunPath ||
		t.legend ||
		t.placeCard ||
		t.furniture
	);
}

/** The pack (and its decoded cover) for a location, while `active`. */
export function useTerroirPack(lat: number, lon: number, active: boolean) {
	const [pack, setPack] = useState<TerroirPack | null>(null);
	const [cover, setCover] = useState<CoverGrid | null>(null);
	useEffect(() => {
		if (!active) return;
		let live = true;
		findPack(lat, lon).then((p) => {
			if (!live) return;
			setPack(p);
			if (p) loadCover(p).then((c) => live && setCover(c));
		});
		return () => {
			live = false;
		};
	}, [lat, lon, active]);
	return { pack: active ? pack : null, cover: active ? cover : null };
}

export function TerroirLayer(props: {
	engine: Renderer | null;
	style: ViewStyle;
	mode: "overlay" | "replace" | "world";
	w: number;
	h: number;
	uncertain: boolean;
	lat: number;
	lon: number;
	takenAt: string | null;
	stageEl?: HTMLElement | null;
	/** bump to re-render (e.g. the labels array changed) */
	tick?: unknown;
	children?: ReactNode;
}) {
	const { engine, style, mode, w, h } = props;
	const active = terroirActive(style);
	const { pack, cover } = useTerroirPack(props.lat, props.lon, active);
	const [frame, setFrame] = useState(0);

	// land cover for the shaders (contour ink by ground, real cover in Blend / In map); null = off
	const needCover = style.terroir.cover.on || style.terroir.contours.inkByCover;
	useEffect(() => {
		if (!engine?.setTerroirCover) return;
		engine.setTerroirCover(needCover ? cover : null);
	}, [engine, cover, needCover]);

	useEffect(() => {
		if (!engine || !active) return;
		let raf = 0;
		const off = engine.onRender(() => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				setFrame((f) => f + 1);
			});
		});
		return () => {
			off();
			if (raf) cancelAnimationFrame(raf);
		};
	}, [engine, active]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: props.tick forces a refresh (labels changed)
	const ctx = useMemo<TerroirCtx | null>(
		() =>
			engine && active && w > 0 && h > 0
				? {
						engine,
						pack,
						cover,
						style,
						mode,
						w,
						h,
						frame,
						uncertain: props.uncertain,
						takenAt: props.takenAt,
						stageEl: props.stageEl ?? null,
					}
				: null,
		[
			engine,
			active,
			pack,
			cover,
			style,
			mode,
			w,
			h,
			frame,
			props.uncertain,
			props.takenAt,
			props.stageEl,
			props.tick,
		],
	);
	if (!ctx) return null;
	const t = style.terroir;
	const photoCam = mode !== "world";
	return (
		<>
			{photoCam && t.glacier.on && <GlacierGhost ctx={ctx} />}
			{photoCam && t.sunPath && <SunPath ctx={ctx} />}
			{photoCam && t.names.on && <NamesSvg ctx={ctx} />}
			{photoCam && t.placeCard && <PlaceCard ctx={ctx} />}
			{t.legend && <Legend ctx={ctx} />}
			{t.furniture && <Furniture ctx={ctx} />}
			{props.children}
		</>
	);
}
