// View wedge of a GT photo for the DSM tile selection: yaw ± (hfov/2 + 10°).
import { vfovFromFocal } from "../../../src/lib/camera";

export function wedgeOf(p: {
	yaw: number | null;
	f: number | null;
	width: number;
	height: number;
}) {
	const vfov = vfovFromFocal(p.f as number, p.height);
	const hfov =
		(2 *
			Math.atan(Math.tan((vfov * Math.PI) / 360) * (p.width / p.height)) *
			180) /
		Math.PI;
	return { yawDeg: p.yaw as number, halfDeg: hfov / 2 + 10 };
}
