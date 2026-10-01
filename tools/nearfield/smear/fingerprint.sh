#!/bin/sh
# hash of the code the smear numbers depend on (nearfield lib + both engines + drape shaders)
cd "$(dirname "$0")/../../.." && cat src/lib/nearfield/*.ts src/lib/deck/engine.ts src/lib/deck/terrain-layer.ts | shasum | cut -c1-12
