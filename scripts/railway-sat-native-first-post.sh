#!/usr/bin/env bash
set -Eeuo pipefail

readonly PROJECT_ID="9c86ff0b-610d-4825-ade7-058ba119b201"
readonly ENVIRONMENT="production"
readonly PILOT_RFC="SMP150917L69"
readonly PILOT_SERVICE_NAME="sat-native-pilot"
readonly WEB_SERVICE_ID="f90843f4-0f56-4910-95eb-86015151f4bf"
readonly POSTGRES_SERVICE_ID="2d21c92e-9117-4ca7-97a3-7b9498fb3799"
readonly REQUIRED_RAILWAY_VERSION="railway 5.49.6"
readonly REQUIRED_CONFIRMATION="ONE_SMP_SIGNED_POST_AUTHORIZED"

usage() {
  printf '%s\n' \
    "Usage: $0 PILOT_SERVICE_ID PREFLIGHT_DEPLOYMENT_ID OPERATOR_USER_ID RUN_UUID ${REQUIRED_CONFIRMATION}" \
    "" \
    "This command arms and triggers one Railway deployment, immediately blanks" \
    "its database/key references and selectors, and prints the captured deployment ID." \
    "It never retries a deployment."
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "$#" -ne 5 ]]; then
  usage >&2
  exit 64
fi

readonly pilot_service_id="$1"
readonly preflight_deployment_id="$2"
readonly operator_user_id="$3"
readonly run_id="$4"
readonly confirmation="$5"

if [[ ! "$pilot_service_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
  printf '%s\n' "Refusing: PILOT_SERVICE_ID must be a lowercase UUID." >&2
  exit 64
fi
if [[ "$pilot_service_id" == "$WEB_SERVICE_ID" || "$pilot_service_id" == "$POSTGRES_SERVICE_ID" ]]; then
  printf '%s\n' "Refusing: the web and Postgres service IDs are never valid pilot targets." >&2
  exit 64
fi
if [[ ! "$preflight_deployment_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
  printf '%s\n' "Refusing: PREFLIGHT_DEPLOYMENT_ID must be a lowercase UUID." >&2
  exit 64
fi
if [[ ! "$operator_user_id" =~ ^[A-Za-z0-9_-]{10,128}$ ]]; then
  printf '%s\n' "Refusing: OPERATOR_USER_ID has an unexpected shape." >&2
  exit 64
fi
if [[ ! "$run_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
  printf '%s\n' "Refusing: RUN_UUID must be a fresh lowercase UUID." >&2
  exit 64
fi
if [[ "$confirmation" != "$REQUIRED_CONFIRMATION" ]]; then
  printf '%s\n' "Refusing: exact action-time confirmation token is required." >&2
  exit 64
fi

for command_name in railway jq; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%s\n' "Refusing: required command is unavailable: $command_name" >&2
    exit 69
  fi
done

if [[ "$(railway --version)" != "$REQUIRED_RAILWAY_VERSION" ]]; then
  printf '%s\n' \
    "Refusing: this trigger was reviewed only for ${REQUIRED_RAILWAY_VERSION}." >&2
  exit 69
fi

services_json="$(railway service list \
  --project "$PROJECT_ID" \
  --environment "$ENVIRONMENT" \
  --json)"
if ! jq -e \
  --arg id "$pilot_service_id" \
  --arg name "$PILOT_SERVICE_NAME" \
  'type == "array"
    and ([.[] | select(.id == $id and .name == $name)] | length == 1)
    and ([.[] | select(.id == $id and .name != $name)] | length == 0)' \
  >/dev/null <<<"$services_json"; then
  printf '%s\n' \
    "Refusing: target ID must resolve uniquely to the production sat-native-pilot service." >&2
  exit 69
fi

before_json="$(railway deployment list \
  --project "$PROJECT_ID" \
  --environment "$ENVIRONMENT" \
  --service "$pilot_service_id" \
  --limit 20 --json)"
if ! jq -e \
  --arg preflight_id "$preflight_deployment_id" \
  'type == "array"
    and length > 0
    and all(.[]; (.id | type == "string") and (.status | type == "string"))
    and .[0].id == $preflight_id
    and .[0].status == "SUCCESS"
    and all(.[];
      .status == "SUCCESS"
      or .status == "FAILED"
      or .status == "CRASHED"
      or .status == "REMOVED"
      or .status == "SLEEPING"
      or .status == "SKIPPED")' \
  >/dev/null <<<"$before_json"; then
  printf '%s\n' \
    "Refusing: the expected preflight must be the latest SUCCESS and no pilot deployment may be active." >&2
  exit 69
fi
readonly before_ids="$(jq -c '[.[].id]' <<<"$before_json")"

armed=false
disarm() {
  railway variable set \
    SAT_NATIVE_PILOT_ACTION=DISABLED \
    SAT_NATIVE_PILOT_ENABLED=false \
    'SAT_NATIVE_PILOT_RFC=' \
    'SAT_NATIVE_PILOT_OPERATOR_USER_ID=' \
    'SAT_NATIVE_PILOT_RUN_ID=' \
    'SAT_NATIVE_PILOT_ACKNOWLEDGEMENT=' \
    'SAT_NATIVE_PILOT_EXECUTION_SCOPE=' \
    'DATABASE_URL=' \
    'CREDENTIALS_ENCRYPTION_KEY=' \
    --skip-deploys \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT" \
    --service "$pilot_service_id" \
    >/dev/null
}

cleanup() {
  if [[ "$armed" == "true" ]]; then
    if ! disarm; then
      printf '%s\n' \
        "CRITICAL: automatic disarm failed. Do not deploy or redeploy this service." >&2
    fi
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# One variable collection update both arms the worker and triggers its sole
# deployment. Dockerfile builds cannot read these runtime values because the
# Dockerfile declares no matching ARG instructions.
armed=true
set +e
railway variable set \
  'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  'CREDENTIALS_ENCRYPTION_KEY=${{contabilidad-os.CREDENTIALS_ENCRYPTION_KEY}}' \
  SAT_NATIVE_PILOT_ACTION=FIRST_SIGNED_POST \
  SAT_NATIVE_PILOT_ENABLED=true \
  SAT_NATIVE_PILOT_RFC="$PILOT_RFC" \
  SAT_NATIVE_PILOT_OPERATOR_USER_ID="$operator_user_id" \
  SAT_NATIVE_PILOT_RUN_ID="$run_id" \
  SAT_NATIVE_PILOT_ACKNOWLEDGEMENT=METADATA_ONLY_READ_ONLY_SAT_1024_BIT_DHE \
  SAT_NATIVE_PILOT_EXECUTION_SCOPE=FIRST_SIGNED_POST_ONLY \
  --project "$PROJECT_ID" \
  --environment "$ENVIRONMENT" \
  --service "$pilot_service_id"
trigger_status="$?"
set -e

if ! disarm; then
  printf '%s\n' \
    "CRITICAL: signed variables may still be staged. Do not deploy or redeploy." >&2
  exit 70
fi
armed=false
trap - EXIT HUP INT TERM

new_ids='[]'
after_json='[]'
for _attempt in {1..15}; do
  after_json="$(railway deployment list \
    --project "$PROJECT_ID" \
    --environment "$ENVIRONMENT" \
    --service "$pilot_service_id" \
    --limit 20 --json)"
  after_ids="$(jq -c '[.[].id]' <<<"$after_json")"
  new_ids="$(jq -cn \
    --argjson before "$before_ids" \
    --argjson after "$after_ids" \
    '$after - $before')"
  if [[ "$(jq 'length' <<<"$new_ids")" -gt 0 ]]; then
    break
  fi
  sleep 2
done

readonly new_count="$(jq 'length' <<<"$new_ids")"
jq -c --argjson ids "$new_ids" \
  '[.[] as $deployment
    | select($ids | index($deployment.id))
    | {
        id: $deployment.id,
        status: $deployment.status,
        createdAt: $deployment.createdAt
      }]' <<<"$after_json"

if [[ "$new_count" -eq 0 ]]; then
  printf '%s\n' \
    "No deployment ID was captured. Signed mode is disarmed; do not retry without a new approval." >&2
  exit 71
fi
if [[ "$new_count" -ne 1 ]]; then
  printf '%s\n' \
    "Ambiguous deployment set captured. Inspect every printed ID; do not retry." >&2
  exit 72
fi

readonly deployment_id="$(jq -r '.[0]' <<<"$new_ids")"
printf '%s\n' "SAT_NATIVE_PILOT_DEPLOYMENT_ID=${deployment_id}"
if [[ "$trigger_status" -ne 0 ]]; then
  printf '%s\n' \
    "Railway returned status ${trigger_status}, but one deployment exists. Inspect that ID; do not retry." >&2
  exit 73
fi
