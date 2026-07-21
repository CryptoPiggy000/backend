#!/usr/bin/env bash
# Ops-indexer integration test: start anvil → run the OpsScenario forge script → point the real index +
# value passes + JSON API at that chain and assert (test/ops.integration.test.ts). Self-contained.
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$(cd "$BACKEND_DIR/../contracts" && pwd)"
RPC="http://127.0.0.1:8545"
ANVIL_PID=""

cleanup() { [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "▸ starting anvil…"
anvil --silent --port 8545 &
ANVIL_PID=$!
for i in $(seq 1 30); do
  if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then break; fi
  sleep 0.3
done

echo "▸ running OpsScenario (deploy + 2 users through deposit/buy/withdraw)…"
OUT="$(cd "$CONTRACTS_DIR" && forge script script/OpsScenario.s.sol:OpsScenario \
  --rpc-url "$RPC" --broadcast --skip-simulation 2>&1)"

addr() { echo "$OUT" | grep -oE "$1 0x[0-9a-fA-F]{40}" | tail -1 | grep -oE '0x[0-9a-fA-F]{40}'; }
export REGISTRY="$(addr REGISTRY)"
export FACTORY="$(addr FACTORY)"
export USDC="$(addr USDC)"
export AAVE="$(addr AAVE)"
export WSTETH="$(addr WSTETH)"
export ACCT1="$(addr ACCT1)"
export ACCT2="$(addr ACCT2)"
export RPC

if [ -z "$REGISTRY" ] || [ -z "$FACTORY" ] || [ -z "$ACCT1" ]; then
  echo "✗ failed to parse scenario addresses. forge output:"; echo "$OUT" | tail -40; exit 1
fi
echo "  REGISTRY=$REGISTRY FACTORY=$FACTORY ACCT1=$ACCT1 ACCT2=$ACCT2"

echo "▸ running the indexer integration test…"
cd "$BACKEND_DIR" && npx tsx test/ops.integration.test.ts
