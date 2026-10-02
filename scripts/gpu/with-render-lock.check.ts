// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CR-02: killing with-render-lock.mjs must also kill the job it wraps (and the job's own children).
// Uses a private temp RIGI_RENDER_LOCK_DIR, never the shared ~/.cache/rigi queue, and a harmless `sleep` as the job. Usage: npx tsx scripts/gpu/with-render-lock.check.ts
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const wrapper = resolve(import.meta.dirname, "with-render-lock.mjs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function waitFor(test: () => boolean, ms: number): Promise<boolean> {
	for (let waited = 0; waited < ms; waited += 50) {
		if (test()) return true;
		await sleep(50);
	}
	return test();
}

async function runCase(signal: NodeJS.Signals): Promise<string[]> {
	const failures: string[] = [];
	const dir = mkdtempSync(join(tmpdir(), "rigi-lock-check-"));
	const pidFile = join(dir, "job.pid");
	const grandchildFile = join(dir, "grandchild.pid");
	// the job: a shell with a backgrounded sleep (a grandchild), recording both pids
	const job = `echo $$ > ${pidFile}; sleep 300 & echo $! > ${grandchildFile}; wait`;
	const wrapperProcess = spawn(
		process.execPath,
		[wrapper, "--", "sh", "-c", job],
		{
			stdio: "ignore",
			env: {
				...process.env,
				RIGI_RENDER_LOCK_DIR: dir,
				RENDER_LOCK_SLOTS: "1",
				RENDER_LOCK_EXCLUSIVE: "0",
			},
		},
	);
	const wrapperExit = new Promise<number | null>((r) =>
		wrapperProcess.on("exit", (code) => r(code)),
	);
	const started = await waitFor(
		() => existsSync(pidFile) && existsSync(grandchildFile),
		30_000,
	);
	if (!started) {
		wrapperProcess.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
		return [`${signal}: job never started`];
	}
	const jobPid = Number(readFileSync(pidFile, "utf8"));
	const grandchildPid = Number(readFileSync(grandchildFile, "utf8"));
	if (!alive(jobPid) || !alive(grandchildPid))
		failures.push(`${signal}: job not running before the signal`);
	if (!existsSync(join(dir, "render-lock-0")))
		failures.push(`${signal}: lock slot not held while the job runs`);

	wrapperProcess.kill(signal);
	const code = await Promise.race([wrapperExit, sleep(15_000).then(() => -1)]);
	if (code === -1) failures.push(`${signal}: wrapper did not exit`);
	if (!(await waitFor(() => !alive(jobPid), 5000)))
		failures.push(`${signal}: job (pid ${jobPid}) survived the wrapper`);
	if (!(await waitFor(() => !alive(grandchildPid), 5000)))
		failures.push(
			`${signal}: job's child (pid ${grandchildPid}) survived the wrapper`,
		);
	if (existsSync(join(dir, "render-lock-0")))
		failures.push(`${signal}: lock slot not released`);
	for (const pid of [jobPid, grandchildPid])
		if (alive(pid)) process.kill(pid, "SIGKILL");
	rmSync(dir, { recursive: true, force: true });
	return failures;
}

/** CR-52: an ownerless / malformed lock dir is reclaimed once stale, but not while it is fresh. */
async function runOwnerlessCase(
	label: string,
	ownerText: string | null,
	ageSeconds: number,
	expectReclaimed: boolean,
): Promise<string[]> {
	const dir = mkdtempSync(join(tmpdir(), "rigi-lock-check-"));
	const lock = join(dir, "render-lock-0");
	mkdirSync(lock);
	if (ownerText !== null) writeFileSync(join(lock, "owner"), ownerText);
	const then = new Date(Date.now() - ageSeconds * 1000);
	utimesSync(lock, then, then);
	const marker = join(dir, "ran");
	const wrapperProcess = spawn(
		process.execPath,
		[wrapper, "--", "sh", "-c", `echo ok > ${marker}`],
		{
			stdio: "ignore",
			env: {
				...process.env,
				RIGI_RENDER_LOCK_DIR: dir,
				RENDER_LOCK_SLOTS: "1",
				RENDER_LOCK_EXCLUSIVE: "0",
				RENDER_LOCK_OWNERLESS_GRACE_MS: "5000",
				RENDER_LOCK_MEM_WAIT_S: "1",
			},
		},
	);
	const ran = await waitFor(
		() => existsSync(marker),
		expectReclaimed ? 30_000 : 2500,
	);
	wrapperProcess.kill("SIGKILL");
	rmSync(dir, { recursive: true, force: true });
	if (ran === expectReclaimed) return [];
	return [
		`${label}: lock ${expectReclaimed ? "was not reclaimed" : "was reclaimed too early"}`,
	];
}

/** CR-52: the memory-headroom wait gives up after RENDER_LOCK_MEM_WAIT_S and starts the job. */
async function runMemoryTimeoutCase(): Promise<string[]> {
	if (spawnSync("memory_pressure", { stdio: "ignore" }).error) return []; // not macOS
	const dir = mkdtempSync(join(tmpdir(), "rigi-lock-check-"));
	const started = Date.now();
	const r = spawnSync(process.execPath, [wrapper, "--", "sh", "-c", "exit 7"], {
		encoding: "utf8",
		timeout: 30_000,
		env: {
			...process.env,
			RIGI_RENDER_LOCK_DIR: dir,
			RENDER_LOCK_SLOTS: "1",
			RENDER_LOCK_EXCLUSIVE: "0",
			RENDER_LOCK_MEM_MIN_FREE: "101", // never satisfiable
			RENDER_LOCK_MEM_WAIT_S: "1",
			RENDER_LOCK_MEM_POLL_S: "0.2",
		},
	});
	rmSync(dir, { recursive: true, force: true });
	const failures: string[] = [];
	if (r.status !== 7)
		failures.push(`memory wait: job not started (status ${r.status})`);
	if (!/timed out/.test(r.stderr ?? ""))
		failures.push("memory wait: no timeout warning");
	if (Date.now() - started > 20_000)
		failures.push("memory wait: took too long");
	return failures;
}

const failures = [
	...(await runCase("SIGTERM")),
	...(await runCase("SIGINT")),
	...(await runOwnerlessCase("ownerless stale", null, 3600, true)),
	...(await runOwnerlessCase("malformed owner stale", "garbage", 3600, true)),
	...(await runOwnerlessCase("ownerless fresh", null, 0, false)),
	...(await runMemoryTimeoutCase()),
];
if (failures.length) {
	console.error(failures.join("\n"));
	process.exit(1);
}
console.log(
	"with-render-lock: SIGTERM and SIGINT kill the job group and free the slot; stale ownerless locks are reclaimed; the memory wait is bounded",
);
