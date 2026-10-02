// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useMemo } from "react";
import { SketchPath } from "../notebook/Ink";

export interface HachureRuleProps {
	/** Seed for the deterministic stroke lengths. */
	seed?: number;
	/** Number of hachure strokes. */
	count?: number;
	className?: string;
}

function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Rock {
	apexX: number;
	apexY: number;
	baseY: number;
	left: number;
	right: number;
}

/**
 * Section divider in the manner of Swiss rock drawing: a patchwork of small triangular rock
 * elements along a wandering baseline. Each has a shaded right face (filled tapered wedges that
 * touch the ridge) and a lit left face (thin broken strokes that stop short of it). Strokes run
 * parallel to their face edge, so none cross. Higher elements are drawn darker (aerial
 * perspective). Stretches to full width; decorative.
 */
export function HachureRule({
	seed = 7,
	count = 110,
	className,
}: HachureRuleProps) {
	const { ridge, shade, lit, rocks } = useMemo(() => {
		const rand = mulberry32(seed);
		const w = 1000;
		const n = Math.max(2, Math.round(count / 3));
		const pitch = w / n;
		const base = 18;
		const list: Rock[] = [];
		for (let i = 0; i < n; i++) {
			const baseY = 17 + Math.sin(i * 0.7 + seed) * 1.2 + (rand() - 0.5) * 0.8;
			const height = 5 + rand() * 8.5;
			const left = i * pitch + (pitch - base) / 2 + (rand() - 0.5) * 3;
			list.push({
				left,
				right: left + base,
				baseY,
				apexX: left + base * (0.38 + rand() * 0.24),
				apexY: Math.max(1, baseY - height),
			});
		}
		const order = [...list].sort(
			(a, b) => b.baseY - b.apexY - (a.baseY - a.apexY),
		);
		const opacityOf = new Map<Rock, number>();
		order.forEach((rock, rank) => {
			const q = 1 - rank / Math.max(1, n - 1);
			opacityOf.set(rock, q >= 0.75 ? 0.95 : 0.75 + (0.2 * q) / 0.75);
		});
		let ridgeD = "";
		const shadeByOpacity = new Map<number, string>();
		let litD = "";
		list.forEach((rock, i) => {
			ridgeD += `${i === 0 ? "M" : "L"}${rock.left.toFixed(1)} ${rock.baseY.toFixed(2)}L${rock.apexX.toFixed(1)} ${rock.apexY.toFixed(2)}`;
			const h = rock.baseY - rock.apexY;
			const slopeR = (rock.right - rock.apexX) / h;
			const slopeL = (rock.apexX - rock.left) / h;
			// shaded right face: parallel tapered wedges that start on the ridge
			const wanted = 3 + Math.floor(rand() * 3);
			const gap = Math.max(1.6, 2.4 / slopeR);
			const k = Math.max(2, Math.min(wanted, Math.floor((h - 1.5) / gap)));
			let d = "";
			for (let j = 0; j < k; j++) {
				const t = 0.8 + j * gap;
				const y0 = rock.apexY + t;
				if (y0 >= rock.baseY - 1) break;
				const x0 = rock.apexX;
				const x1 = x0 + (rock.baseY - y0) * slopeR * 0.94;
				const top = 1.6 + rand() * 0.3;
				const foot = 1.2;
				d += `M${(x0 - top / 2).toFixed(2)} ${y0.toFixed(2)}L${(x0 + top / 2).toFixed(2)} ${y0.toFixed(2)}L${(x1 + foot / 2).toFixed(2)} ${rock.baseY.toFixed(2)}L${(x1 - foot / 2).toFixed(2)} ${rock.baseY.toFixed(2)}Z`;
			}
			const opacity = opacityOf.get(rock) ?? 0.85;
			shadeByOpacity.set(opacity, (shadeByOpacity.get(opacity) ?? "") + d);
			// lit left face: thin strokes that stop 1.2 units short of the ridge
			const litCount = 2 + Math.floor(rand() * 2);
			for (let j = 0; j < litCount; j++) {
				const y0 = rock.apexY + 2.5 + j * 2.6;
				if (y0 >= rock.baseY - 1.5) break;
				const x0 = rock.apexX - 1.2;
				const x1 = x0 - (rock.baseY - y0) * slopeL * 0.8;
				litD += `M${x0.toFixed(2)} ${y0.toFixed(2)}L${x1.toFixed(2)} ${(rock.baseY - 0.8).toFixed(2)}`;
			}
		});
		ridgeD += `L${list[n - 1].right.toFixed(1)} ${list[n - 1].baseY.toFixed(2)}`;
		return {
			ridge: ridgeD,
			shade: [...shadeByOpacity.entries()],
			lit: litD,
			rocks: list.length,
		};
	}, [seed, count]);
	return (
		<svg
			aria-hidden="true"
			className={`block h-5 w-full ${className ?? ""}`}
			viewBox="0 0 1000 20"
			preserveAspectRatio="none"
			data-rocks={rocks}
		>
			{shade.map(([opacity, d]) => (
				<path key={opacity} d={d} fill="var(--gb-ink)" fillOpacity={opacity} />
			))}
			<path
				d={lit}
				fill="none"
				stroke="var(--gb-ink)"
				strokeWidth={0.5}
				strokeDasharray="2.2 1.4"
				strokeOpacity={0.85}
				style={{ vectorEffect: "non-scaling-stroke" }}
			/>
			<SketchPath
				d={ridge}
				seed={`hachure-rule-${seed}`}
				color="ink"
				width={0.75}
				opacity={0.6}
				tolerance={0.4}
				passes={1}
				className="[&_path]:[vector-effect:non-scaling-stroke]"
			/>
		</svg>
	);
}
