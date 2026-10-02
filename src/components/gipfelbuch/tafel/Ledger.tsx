// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { PenLine } from "../notebook/Ink";
import { TYPE } from "../swiss/type";
import "./tafel.css";

export type LedgerItem = {
	value: string;
	unit?: string;
	label: string;
	/** JSON path into GipfelbuchPhotoData, for the check. */
	path: string;
};

/** A result is underlined twice by hand (sketch-style §3: double underline = result). */
function ResultUnderline({ seed }: { seed: string }) {
	return (
		<svg
			className="block h-[7px] w-[72px] overflow-visible"
			viewBox="0 0 72 7"
			aria-hidden="true"
		>
			<PenLine
				from={[0, 2]}
				to={[70, 1.5]}
				seed={`${seed}-a`}
				color="red"
				width={1.2}
			/>
			<PenLine
				from={[4, 5.5]}
				to={[58, 5]}
				seed={`${seed}-b`}
				color="red"
				width={1}
				opacity={0.8}
			/>
		</svg>
	);
}

/** Two to four measured values, written into the field book in hand figures: a list on desktop, a 3-up row on a phone. Words only in `note`. */
export function Ledger({
	items,
	note,
}: {
	items: LedgerItem[];
	note?: string;
}) {
	if (import.meta.env.DEV && note && /\d/.test(note)) {
		console.warn(`[Ledger] the note is words only, no digits: "${note}"`);
	}
	const words = note?.replace(/\d+/g, "").trim();
	return (
		<div className="gb-swiss-ledger [container-type:inline-size]">
			{/* a 3-up row on a phone; in the header rail a list, value over label until there is room beside it */}
			<dl className="m-0 grid grid-cols-3 gap-x-4 gap-y-0 sm:grid-cols-1 sm:gap-y-4">
				{items.map((item) => (
					<div
						key={item.path}
						className="flex flex-col [@container(min-width:440px)]:grid [@container(min-width:440px)]:grid-cols-[minmax(120px,auto)_1fr] [@container(min-width:440px)]:items-baseline [@container(min-width:440px)]:gap-x-4"
					>
						<dt className="m-0 order-2 [@container(min-width:440px)]:order-none [@container(min-width:440px)]:col-start-2 [@container(min-width:440px)]:row-start-1">
							<span className={`block ${TYPE.handLabel} gb-secondary`}>
								{item.label.split("\n").map((line) => (
									<span key={line} className="block">
										{line}
									</span>
								))}
							</span>
						</dt>
						<dd className="m-0 order-1 whitespace-nowrap [@container(min-width:440px)]:order-none [@container(min-width:440px)]:col-start-1 [@container(min-width:440px)]:row-start-1">
							<span className="nb-num text-[26px] leading-[30px] sm:text-[40px] sm:leading-[48px]">
								{item.value}
							</span>
							{item.unit && (
								<span className="gb-secondary ml-1 text-[13px] leading-[18px] sm:text-[16px] sm:leading-[24px]">
									{item.unit}
								</span>
							)}
							<ResultUnderline seed={`ledger-${item.path}`} />
						</dd>
					</div>
				))}
			</dl>
			{words && (
				<p
					className="nb-hand mt-3 -rotate-1 text-[20px] leading-[24px]"
					style={{ color: "var(--gb-water)" }}
				>
					{words}
				</p>
			)}
		</div>
	);
}
