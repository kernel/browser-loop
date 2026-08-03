#!/usr/bin/env bash
set -euo pipefail

ANSWER="$(cat /logs/agent/answer.txt 2>/dev/null || true)"
if echo "$ANSWER" | grep -qi "Example Domain"; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
