#!/bin/sh
# All deck-webgpu browser checks in one render-lock slot:
#   node scripts/gpu/with-render-lock.mjs -- sh scripts/deck-webgpu/battery.sh
# Needs :3111 (vite.webgpu.config.ts) and :3110 (the app config, deck webgl-only → direct host).
cd "$(dirname "$0")/../.."
O=out/deck-webgpu
mkdir -p $O
node scripts/deck-webgpu/spike.mjs > $O/battery-spike.txt 2>&1; echo "spike exit $?"
node scripts/deck-webgpu/smoke.mjs IMG_7086 --host deck > $O/battery-deck.txt 2>&1; echo "deck exit $?"
node scripts/deck-webgpu/smoke.mjs IMG_7086 --host direct > $O/battery-direct.txt 2>&1; echo "direct exit $?"
node scripts/deck-webgpu/smoke.mjs IMG_7086 --host deck --query "plugin=footprint&yaw=150" > $O/battery-footprint.txt 2>&1; echo "footprint exit $?"
node scripts/deck-webgpu/smoke.mjs IMG_6958 --host deck > $O/battery-6958.txt 2>&1; echo "6958 exit $?"
APP_URL=http://localhost:3110 node scripts/deck-webgpu/smoke.mjs IMG_7086 > $O/battery-3110.txt 2>&1; echo "3110 exit $?"
