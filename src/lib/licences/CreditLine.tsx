// The data-credit line under the photo details. Classic mode renders the app's historic text
// verbatim (same element, same class); `?attrib=full` renders per-source credits with links.
import { useMemo } from "react";
import { useFlag } from "#/lib/flags/react";
import {
	type AttributionQuery,
	attributionFor,
	CLASSIC_UI_LINE,
	fullAttribution,
} from "./attribution";

export function CreditLine({
	className,
	...q
}: AttributionQuery & { className?: string }) {
	const attrib = useFlag("attrib");
	// biome-ignore lint/correctness/useExhaustiveDependencies: attrib re-reads the setting when ?attrib changes
	const full = useMemo(() => fullAttribution(), [attrib]);
	const { lat, lon, radiusKm, imagery, provider, osm: withOsm } = q;
	const credits = useMemo(
		() =>
			full
				? attributionFor({
						lat,
						lon,
						radiusKm,
						imagery,
						provider,
						osm: withOsm,
					})
				: [],
		[full, lat, lon, radiusKm, imagery, provider, withOsm],
	);
	if (!full) return <p className={className}>{CLASSIC_UI_LINE}</p>;
	const group = (kinds: string[]) =>
		credits.filter((c) => kinds.includes(c.kind));
	const links = (cs: typeof credits) =>
		cs.map((c, i) => (
			<span key={c.id}>
				{i ? ", " : ""}
				{c.href ? (
					<a
						href={c.href}
						target="_blank"
						rel="noreferrer"
						className="underline decoration-white/20 hover:text-white/60"
					>
						{c.label}
					</a>
				) : (
					c.label
				)}
			</span>
		));
	const dem = group(["dem"]);
	const img = group(["imagery", "map"]).filter((c) => c.id !== "osm");
	const osm = credits.some((c) => c.id === "osm");
	return (
		<p className={className} data-credits="full">
			Terrain © {links(dem.slice(0, 1))}
			{dem.length > 1 ? <> ({links(dem.slice(1))})</> : null}
			{img.length ? <> · Imagery © {links(img)}</> : null}
			{osm ? (
				<>
					{" "}
					· Peaks & trails ©{" "}
					<a
						href="https://www.openstreetmap.org/copyright"
						target="_blank"
						rel="noreferrer"
						className="underline decoration-white/20 hover:text-white/60"
					>
						OpenStreetMap contributors
					</a>
				</>
			) : null}
		</p>
	);
}
