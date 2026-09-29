"""Run a command once the machine has headroom.

mt-image-58's TM worker holds tools/research/tm/.render.lock and .gpu.lock for hours at a time,
so blocking on them would stall every GPU workstream. out/.render-lock already keeps it to one extra
Chromium from us. This helper adds a memory guard on top: wait while free memory is below 25%. Swap
*use* is not checked: it stays high long after pressure is gone, and gating on it deadlocked the queue.
Usage: python3 scripts/gpu/tm_locks.py <cmd> [args...]"""
import re, subprocess, sys, time


def headroom():
    free = int(re.search(r"(\d+)%", subprocess.run(["memory_pressure"], capture_output=True, text=True).stdout.splitlines()[-1]).group(1))
    swap = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout
    used = float(re.search(r"used = ([\d.]+)M", swap).group(1))
    return free, used


t0 = 0
while True:
    free, used = headroom()
    if free >= 25:
        break
    if time.time() - t0 > 60:
        print(f"[render-lock] waiting for memory headroom (free {free}%, swap {used:.0f} MB)", file=sys.stderr, flush=True)
        t0 = time.time()
    time.sleep(5)
sys.exit(subprocess.call(sys.argv[1:]))
