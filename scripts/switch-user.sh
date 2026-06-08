#!/usr/bin/env bash
# 데모용 사용자 전환 — Claude Code 외부에서 source로 실행.
# 사용:  source scripts/switch-user.sh alice
#        source scripts/switch-user.sh bob
# 그 다음 Claude Code에서 /mcp -> reconnect 또는 새 세션 시작.
set -e
USER="${1:-}"
case "$USER" in
  alice|bob|carol|eric) ;;
  *)
    echo "usage: source scripts/switch-user.sh <alice|bob|carol|eric>" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

export ACHARNESS_USER="$USER"
# 캐시 무효화: 강제 재발급
rm -f "${TMPDIR:-/tmp}/acharness-token-$USER.cache"
echo "ACHARNESS_USER=$USER (cache cleared)"
echo "다음 단계: Claude Code에서 /mcp -> acharness-gateway reconnect, 또는 새 세션."
