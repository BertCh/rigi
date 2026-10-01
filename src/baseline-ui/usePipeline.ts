import { useCallback, useEffect, useRef, useState } from "react";
import type { Camera } from "#/lib/geo/camera";
import { realmGpuOptions } from "#/lib/gpu/core/realm";
import { gpuEnabled } from "#/lib/gpu/device";
import type {
	AlignResult,
	FromWorker,
	HorizonLite,
	PeakView,
	SkylineObservation,
	Stage,
	ToWorker,
} from "./types";

export interface PipelineState {
	progress: {
		stage: Stage;
		message: string;
		done?: number;
		total?: number;
	} | null;
	horizon: {
		horizon: HorizonLite;
		eye: number;
		ground: number;
		ms: number;
	} | null;
	peaks: { views: PeakView[] } | null;
	sky: SkylineObservation | null;
	align: AlignResult | null;
	aligning: boolean;
	errors: Partial<Record<Stage, string>>;
}

const initial: PipelineState = {
	progress: null,
	horizon: null,
	peaks: null,
	sky: null,
	align: null,
	aligning: false,
	errors: {},
};

/** Owns the pipeline worker; stale replies (older run/skyline ids) are dropped. */
export function usePipeline() {
	const worker = useRef<Worker | null>(null);
	const ids = useRef({ run: 0, skyline: 0, align: 0, next: 1 });
	const [state, setState] = useState<PipelineState>(initial);

	useEffect(() => {
		const w = new Worker(new URL("./pipeline.worker.ts", import.meta.url), {
			type: "module",
		});
		worker.current = w;
		w.onmessage = (ev: MessageEvent<FromWorker>) => {
			const m = ev.data;
			const cur = ids.current;
			setState((s) => {
				switch (m.type) {
					case "progress":
						return m.id === cur.run ? { ...s, progress: m } : s;
					case "horizon":
						return m.id === cur.run
							? {
									...s,
									horizon: {
										horizon: m.horizon,
										eye: m.eye,
										ground: m.ground,
										ms: m.ms,
									},
								}
							: s;
					case "peaks":
						return m.id === cur.run
							? {
									...s,
									peaks: { views: m.views },
									progress: null,
								}
							: s;
					case "skyline":
						return m.id === cur.skyline ? { ...s, sky: m.sky } : s;
					case "align":
						return m.id === cur.align
							? { ...s, align: m.result, aligning: false }
							: s;
					case "error": {
						const mine =
							m.id === cur.run || m.id === cur.skyline || m.id === cur.align;
						if (!mine) return s;
						return {
							...s,
							errors: { ...s.errors, [m.stage]: m.message },
							progress:
								m.stage === "tiles" || m.stage === "peaks" ? null : s.progress,
							aligning: m.stage === "align" ? false : s.aligning,
						};
					}
				}
				return s;
			});
		};
		w.onerror = (e) => {
			setState((s) => ({
				...s,
				errors: { ...s.errors, tiles: `Worker error: ${e.message}` },
				progress: null,
			}));
		};
		return () => w.terminate();
	}, []);

	const send = useCallback(
		(msg: ToWorker, transfer: Transferable[] = []) =>
			worker.current?.postMessage(msg, transfer),
		[],
	);

	const run = useCallback(
		(lat: number, lon: number, altitude?: number) => {
			const id = ids.current.next++;
			ids.current.run = id;
			setState((s) => ({
				...s,
				horizon: null,
				peaks: null,
				align: null,
				progress: { stage: "tiles", message: "Starting…" },
				errors: {},
			}));
			send({ type: "run", id, lat, lon, altitude });
		},
		[send],
	);

	const detectSkyline = useCallback(
		(image: ImageData) => {
			const id = ids.current.next++;
			ids.current.skyline = id;
			setState((s) => ({ ...s, sky: null, align: null }));
			const data = image.data;
			send(
				{
					type: "skyline",
					id,
					image: { width: image.width, height: image.height, data },
				},
				[data.buffer],
			);
		},
		[send],
	);

	const align = useCallback(
		(prior: Camera) => {
			const id = ids.current.next++;
			ids.current.align = id;
			setState((s) => ({
				...s,
				aligning: true,
				errors: { ...s.errors, align: undefined },
			}));
			send({
				type: "align",
				id,
				prior,
				solveGpu: gpuEnabled(),
				gpuOpts: realmGpuOptions(),
			});
		},
		[send],
	);

	const clearPhoto = useCallback(() => {
		ids.current.skyline = -1;
		ids.current.align = -1;
		setState((s) => ({ ...s, sky: null, align: null, aligning: false }));
	}, []);

	/** Drops the current location run (e.g. photo without GPS). */
	const clearRun = useCallback(() => {
		ids.current.run = -1;
		setState((s) => ({
			...s,
			horizon: null,
			peaks: null,
			progress: null,
			errors: {},
		}));
	}, []);

	return { state, run, detectSkyline, align, clearPhoto, clearRun };
}
