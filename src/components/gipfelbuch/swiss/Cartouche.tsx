// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { MarkerUnderline } from "./hand";
import { TYPE } from "./type";

export interface CartoucheProps {
	kicker: string;
	title: string;
	subtitle?: string;
	/** Edition line, e.g. "Ausgabe 2026 · LV95". */
	edition?: string;
	className?: string;
}

/**
 * The title block as a Kroki would carry it (S15): no box, a lettered title underlined once by hand,
 * the kicker in hand capitals and the edition written small in pencil.
 */
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
				<p className={`${TYPE.kicker} m-0 tracking-[0.14em]`}>{kicker}</p>
				<div className="relative my-3 inline-block">
					<h1 className={`${TYPE.h1} m-0 sm:text-[48px] sm:leading-[56px]`}>
						{title}
					</h1>
					<MarkerUnderline seed={`cartouche-${title}`} coverage={0.62} />
				</div>
				{subtitle ? <p className={`${TYPE.body} m-0`}>{subtitle}</p> : null}
				{edition ? (
					<p
						className="nb-hand-small mt-6 mb-0 text-[13px] leading-[18px]"
						style={{ color: "var(--gb-pencil)" }}
					>
						{edition}
					</p>
				) : null}
			</div>
		</header>
	);
}
