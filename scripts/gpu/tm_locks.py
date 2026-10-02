"""Run a command once the machine has headroom.

mt-image-58's TM worker holds tools/research/tm/.render.lock and .gpu.lock for hours at a time,
so blocking on them would stall every GPU workstream. out/.render-lock already keeps it to one extra
Chromium from us. This helper adds a memory guard on top: wait while free memory is below 25%. Swap
*use* is not checked: it stays high long after pressure is gone, and gating on it deadlocked the queue.
Usage: python3 scripts/gpu/tm_locks.py <cmd> [args...]"""
import os, re, subprocess, sys, time


def headroom():
    free = int(re.search(r"(\d+)%", subprocess.run(["memory_pressure"], capture_output=True, text=True).stdout.splitlines()[-1]).group(1))
    swap = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout
    used = float(re.search(r"used = ([\d.]+)M", swap).group(1))
    return free, used


# CR-52: the wait is bounded. We already hold the render-lock slot while waiting, so an unbounded
# wait would stall every queued job behind a machine that never frees memory. After
# RENDER_LOCK_MEM_WAIT_S (default 600) the job starts anyway with a warning: the slot limit and the
# wrapper's own MIN_FREE gate for joining running jobs still bound the load, and a stuck queue is
# worse than a slow job.
MIN_FREE = float(os.environ.get("RENDER_LOCK_MEM_MIN_FREE", "25"))
MAX_WAIT = float(os.environ.get("RENDER_LOCK_MEM_WAIT_S", "600"))
POLL = float(os.environ.get("RENDER_LOCK_MEM_POLL_S", "5"))
t0 = 0
started = time.time()
while True:
    free, used = headroom()
    if free >= MIN_FREE:
        break
    if time.time() - started >= MAX_WAIT:
        print(f"[render-lock] memory headroom wait timed out after {MAX_WAIT:.0f}s (free {free}%); starting anyway", file=sys.stderr, flush=True)
        break
    if time.time() - t0 > 60:
        print(f"[render-lock] waiting for memory headroom (free {free}%, swap {used:.0f} MB)", file=sys.stderr, flush=True)
        t0 = time.time()
    time.sleep(POLL)
sys.exit(subprocess.call(sys.argv[1:]))
