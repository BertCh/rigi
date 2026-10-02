// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type CSSProperties, type ReactNode, useId } from "react";
import { splitPrintRuns } from "../notebook/Ink";
import { TYPE } from "../swiss/type";
import "./margin-note.css";

/**
 * A sidenote (design book H6). Put it inline in prose: it renders a superscript mark at the call
 * site and the note right after it in DOM order, so a screen reader reads the mark, then the
 * note. At >= 1024px the note sits in the page margin level with its mark (CSS anchor
 * positioning, floated Tufte-style where unsupported); below that it is an indented inline note.
 *
 * Rules: at most 3 per entry; a `hand` note is 12 words or fewer, and its digits are set in print.
 * The prose column must be positioned (ConceptPage's is) and no transformed ancestor may sit
 * between it and the note. Notes are not stacked: keep them short and apart.
 */
export function MarginNote({
	mark,
	hand,
	children,
}: {
	mark: string;
	hand?: boolean;
	children: ReactNode;
}) {
	const key = useId().replace(/[^a-zA-Z0-9]/g, "");
	const anchor = `--gb-mn-${key}`;
	const noteId = `gb-mn-${key}`;
	const body =
		hand && typeof children === "string"
			? splitPrintRuns(children).map((run, index) =>
					run.print ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: runs are a fixed split of static text
						<span key={index} className="gb-num">
							{run.text}
						</span>
					) : (
						run.text
					),
				)
			: children;
	return (
		<>
			<sup
				className={`${TYPE.micro} gb-mn-mark gb-num`}
				style={{ anchorName: anchor } as CSSProperties}
				aria-describedby={noteId}
			>
				{mark}
			</sup>
			<span
				id={noteId}
				role="note"
				className={`gb-mn-note ${hand ? "nb-hand text-[18px] leading-[24px] text-[var(--gb-pencil)]" : TYPE.caption}`}
				style={{ "--gb-mn-anchor": anchor } as CSSProperties}
			>
				<span className={`gb-mn-ref ${TYPE.micro} gb-num`} aria-hidden>
					{mark}
				</span>
				{body}
			</span>
		</>
	);
}
