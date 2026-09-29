// Types for worker.mjs (headless app driver used by run.ts).
export declare const ROOT: string;
export declare class Worker {
	constructor(opts?: { maxPages?: number; port?: string });
	dead: boolean;
	call(req: Record<string, unknown>, timeoutMs?: number): Promise<any>;
	close(): Promise<void>;
}
