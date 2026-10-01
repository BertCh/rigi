import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PanoramaStrip } from "#/lib/roll/mosaic/PanoramaStrip";
import type { Roll } from "#/lib/roll/types";

// The roll page's own panorama strip, on the sample trip, for the landing page.
// Selecting a photo opens it in the roll view.

export function useDemoRoll() {
	const [roll, setRoll] = useState<Roll | null>(null);
	useEffect(() => {
		let live = true;
		import("#/lib/demo")
			.then((m) => m.loadDemoRoll())
			.then((r) => live && setRoll(r))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	return roll;
}

function useOpen() {
	const navigate = useNavigate();
	return (id: string | null) =>
		id &&
		navigate({
			to: "/roll/$id",
			params: { id: "demo" },
			search: { photo: id },
		});
}

export function DemoPanorama({ roll }: { roll: Roll }) {
	const [sel, setSel] = useState<string | null>(null);
	const open = useOpen();
	return (
		<PanoramaStrip
			roll={roll}
			photos={roll.photos}
			selectedId={sel}
			onSelect={(id) => (id && id === sel ? open(id) : setSel(id))}
			height={380}
			fitHeight
			zoom={false}
		/>
	);
}
