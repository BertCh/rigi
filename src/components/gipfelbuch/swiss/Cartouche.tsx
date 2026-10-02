// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { TYPE } from "./type";

export interface CartoucheProps {
	kicker: string;
	title: string;
	subtitle?: string;
	/** Edition line, e.g. "Ausgabe 2026 · LV95". */
	edition?: string;
	className?: string;
}

/** Neue Grafik cover plate: left-aligned type only, no frame, no ornament. */
export function Cartouche({
	kicker,
	title,
	subtitle,
	edition,
	className,
}: CartoucheProps) {
	return (
		<header
			className={`max-w-[34rem] text-left ${className ?? ""}`}
			style={{ background: "var(--gb-paper)" }}
		>
			<div className="px-6 py-6 sm:px-12 sm:py-12">
				<p className={`${TYPE.kicker} m-0 tracking-[0.18em]`}>{kicker}</p>
				<h1 className={`${TYPE.h1} my-3`}>{title}</h1>
				{subtitle ? <p className={`${TYPE.body} m-0`}>{subtitle}</p> : null}
				{edition ? (
					<p className={`${TYPE.micro} mt-6 mb-0`}>{edition}</p>
				) : null}
			</div>
		</header>
	);
}
