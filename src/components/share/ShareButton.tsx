// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// "Copy share link" for the workspace header (share-link beta, ?share=on; src/lib/share). Disabled
// with a one-line reason when the photo is an upload or the pose is not accepted or confirmed.
import { Check, Link as LinkIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { Pose } from "#/lib/camera";
import { useFlag } from "#/lib/flags/react";
import type { AlignState } from "#/lib/ontology/crosswalk/pose";
import { canShare, isShareableState, shareUrl } from "#/lib/share";
import { cn } from "#/lib/utils";

export function ShareButton({
	photoId,
	pose,
	state,
	disabled,
	className,
}: {
	photoId: string;
	pose: Pose | null;
	state: AlignState | null;
	/** The host's export lock (pose still loading or aligning). */
	disabled?: boolean;
	className?: string;
}) {
	const flag = useFlag("share");
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!copied) return;
		const t = window.setTimeout(() => setCopied(false), 2000);
		return () => window.clearTimeout(t);
	}, [copied]);
	if (flag !== "on") return null;
	const check = canShare(photoId, state);
	const blocked = disabled || !pose || !check.ok;
	const copy = async () => {
		if (!pose || !check.ok || !isShareableState(state)) return;
		setError(null);
		try {
			const url = shareUrl(location.origin, {
				v: 1,
				photo: { kind: "demo", id: photoId },
				pose,
				state,
			});
			await navigator.clipboard.writeText(url);
			setCopied(true);
		} catch {
			setError("Could not copy the link.");
		}
	};
	const note = !check.ok ? check.reason : error;
	return (
		<div
			className={cn("group pointer-events-auto relative", className)}
			data-share-button=""
		>
			<button
				type="button"
				onClick={copy}
				disabled={blocked}
				title={note ?? "Copy a read-only link to this view"}
				className="flex items-center gap-1.5 rounded-lg bg-black/50 px-2.5 py-1.5 text-xs font-medium text-white/80 backdrop-blur hover:text-white disabled:opacity-40"
			>
				{copied ? (
					<Check className="size-3.5" />
				) : (
					<LinkIcon className="size-3.5" />
				)}
				{copied ? "Link copied" : "Copy share link"}
			</button>
			{note && (
				<p
					aria-live="polite"
					className={cn(
						"absolute top-full right-0 mt-1.5 w-60 rounded-lg bg-black/70 px-2.5 py-1.5 text-[11px] leading-snug text-white/70 backdrop-blur",
						// the reason for a disabled button shows on hover; a copy error shows until the next try
						!error && "hidden group-hover:block",
					)}
				>
					{note}
				</p>
			)}
		</div>
	);
}
