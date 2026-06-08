#!/usr/bin/env bash
# AgentCore Gateway용 Cognito id-token 발급 + 캐시.
# Claude Code의 headersHelper로 호출 — 매 connect/reconnect마다 한 번 실행됨.
# stdout: {"Authorization": "Bearer <id-token>"} JSON (그 외 텍스트 금지).
# stderr: 진단 메시지 (Claude Code 무시).
#
# 환경변수:
#   ACHARNESS_USER   필수. alice / bob / carol / eric 중 하나
#   ACHARNESS_CLIENT 필수. Cognito App client id — `cdk deploy` 후
#                    `AcharnessIdentityStack.AppClientId` CfnOutput에서 복사.
#                    또는 scripts/bootstrap-env.sh 실행 시 .env.acharness에
#                    자동 기록.
#   ACHARNESS_PWD    선택. 미지정 시 PoC 기본값 'AcHarness!Demo2026'
#                    (identity-stack.ts의 POC_TEMP_PASSWORD와 일치해야 함).
#   ACHARNESS_REGION 선택. 기본 us-east-1
set -euo pipefail

# Project-local .env.acharness가 있으면 자동 로드 (bootstrap-env.sh가 생성).
ENV_FILE="${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}/.env.acharness"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  set -a; source "$ENV_FILE"; set +a
fi

USER="${ACHARNESS_USER:-}"
if [[ -z "$USER" ]]; then
  echo "ACHARNESS_USER not set" >&2
  exit 1
fi

CLIENT="${ACHARNESS_CLIENT:-}"
if [[ -z "$CLIENT" ]]; then
  echo "ACHARNESS_CLIENT not set — run scripts/bootstrap-env.sh after \`cdk deploy\`" >&2
  exit 1
fi

PWD_VAL="${ACHARNESS_PWD:-AcHarness!Demo2026}"
REGION="${ACHARNESS_REGION:-us-east-1}"

CACHE_DIR="${TMPDIR:-/tmp}"
CACHE_FILE="$CACHE_DIR/acharness-token-$USER.cache"

# Cognito id-token TTL 1h. 안전마진 두고 50분 이내면 캐시 재사용.
if [[ -f "$CACHE_FILE" ]]; then
  AGE=$(( $(date +%s) - $(stat -c %Y "$CACHE_FILE" 2>/dev/null || stat -f %m "$CACHE_FILE") ))
  if (( AGE < 3000 )); then
    TOKEN=$(cat "$CACHE_FILE")
    printf '{"Authorization": "Bearer %s"}\n' "$TOKEN"
    echo "[mcp-token] cache hit ($USER, age=${AGE}s)" >&2
    exit 0
  fi
fi

echo "[mcp-token] minting id-token for $USER" >&2
TOKEN=$(aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id "$CLIENT" \
  --auth-parameters "USERNAME=$USER,PASSWORD=$PWD_VAL" \
  --region "$REGION" \
  --query 'AuthenticationResult.IdToken' \
  --output text)

if [[ -z "$TOKEN" || "$TOKEN" == "None" ]]; then
  echo "initiate-auth returned empty token" >&2
  exit 1
fi

printf '%s' "$TOKEN" > "$CACHE_FILE"
chmod 600 "$CACHE_FILE" 2>/dev/null || true
printf '{"Authorization": "Bearer %s"}\n' "$TOKEN"
