import type { RollPhoto } from "../types";
import {
	compassPoint,
	POSE_SOURCE_CLASS,
	POSE_SOURCE_HINT,
	POSE_SOURCE_LABEL,
	vpColor,
} from "./style";

export function PoseBadge({
	photo,
	className = "",
}: {
	photo: RollPhoto;
	className?: string;
}) {
	return (
		<span
			title={POSE_SOURCE_HINT[photo.poseSource]}
			className={`rounded px-1.5 py-px text-[9.5px] font-semibold tracking-wide uppercase ${POSE_SOURCE_CLASS[photo.poseSource]} ${className}`}
		>
			{POSE_SOURCE_LABEL[photo.poseSource]}
		</span>
	);
}

/** Heading chip: a needle rotated to the heading, the degrees and the compass point. */
export function HeadingChip({
	photo,
	className = "",
}: {
	photo: RollPhoto;
	className?: string;
}) {
	const yaw = ((photo.pose.yaw % 360) + 360) % 360;
	return (
		<span
			title={`Heading ${yaw.toFixed(1)}° (true)`}
			className={`inline-flex items-center gap-1 rounded-full bg-black/65 py-px pr-1.5 pl-1 font-mono text-[10px] text-white/90 backdrop-blur-sm ${className}`}
		>
			<svg viewBox="-6 -6 12 12" className="size-3" aria-hidden="true">
				<circle
					r="5.5"
					fill="none"
					stroke={vpColor(photo.viewpoint)}
					strokeWidth="1"
				/>
				<path
					d="M0,-4.5 L1.8,1.5 L0,0.6 L-1.8,1.5 Z"
					fill="currentColor"
					transform={`rotate(${yaw})`}
				/>
			</svg>
			{Math.round(yaw)}° {compassPoint(yaw)}
		</span>
	);
}
