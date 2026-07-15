#!/usr/bin/env bash
# Simulation du Durable Object hors runtime Cloudflare.
# A lancer depuis worker/ :  bash simtest/run.sh
# Compatible git-bash sous Windows.
set -e
cd "$(dirname "$0")/.."

echo "== typecheck =="
node node_modules/typescript/bin/tsc --noEmit
echo "ok"

echo "== build jetable =="
rm -rf build
node node_modules/typescript/bin/tsc \
  --outDir build --noEmit false \
  --module ES2022 --target ES2022 --moduleResolution Bundler --skipLibCheck \
  src/motsmeles/room.ts >/dev/null 2>&1 || true
# tsc emet des imports sans extension ; Node ESM les exige.
find build -name "*.js" -exec sed -i -E 's|(from "\.{1,2}/[^"]+)"|\1.js"|g' {} \;
echo '{"type":"module"}' > build/package.json

echo "== scenarios =="
node simtest/mystere.test.mjs
node simtest/convergence.test.mjs

rm -rf build
echo "termine"
