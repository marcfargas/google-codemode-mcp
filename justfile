set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# Run the credential-free GitHub workflow locally in act.
check:
    node apps/executor/tests/act.mjs check

# Run the workflow's checks directly on this machine.
verify:
    node apps/executor/tests/run.mjs check

# Run the credentialed Gmail workflow locally in act.
live:
    node apps/executor/tests/act.mjs live

# Verify Drive files, conditional-option refusal and explicit pagination.
live-drive:
    node apps/executor/tests/act.mjs live-drive

# Verify exact Gmail/Drive byte composition and native exports.
live-media:
    node apps/executor/tests/act.mjs live-media

# One on-demand agent case; an optional second trial observes caching.
eval $profile $model $proxy_url $output $repeats='1':
    node apps/executor/tests/eval/act.mjs

# Sonnet 5.5 and GPT-6.2 Sol by default; select all for the six-model comparison.
eval-matrix $profile $proxy_url $output $selection='required':
    node apps/executor/tests/eval/act.mjs

# Six independent Gmail cases, one attempt per selected model and case.
eval-gmail $proxy_url $output $cases='all' $selection='required':
    profile=gmail node apps/executor/tests/eval/act.mjs

# Four independent Drive cases after just oauth --drive.
eval-drive $proxy_url $output $cases='all' $selection='required':
    profile=drive node apps/executor/tests/eval/act.mjs

# Two Gmail/Drive composition cases, one attempt per selected model/case.
eval-media $proxy_url $output $cases='all' $selection='required':
    profile=media node apps/executor/tests/eval/act.mjs

# Two artifact cases through local Miniflare R2, four $1 attempts.
eval-artifacts $proxy_url $output $cases='all' $selection='required':
    profile=artifacts node apps/executor/tests/eval/act.mjs

# Prove isolated runner/file/MCP behavior with synthetic responses only.
eval-preflight $output:
    profile=gmail proxy_url=http://127.0.0.1:1 selection=required preflight_only=true node apps/executor/tests/eval/act.mjs

# Optional native Codex read-search probe with GPT-6.1 Sol.
eval-native-gmail $proxy_url $output:
    profile=gmail model=gpt-6.1-sol runner=codex node apps/executor/tests/eval/act.mjs

# Exercise native Codex with inert provider/MCP responses and no credentials.
eval-native-preflight $output:
    profile=gmail model=gpt-6.1-sol runner=codex proxy_url=http://127.0.0.1:1 preflight_only=true node apps/executor/tests/eval/act.mjs

# Regrade one retained trial without Google or model requests.
eval-regrade $saved $output:
    node apps/executor/tests/eval/regrade.ts "$saved" "$output"

# Generate metrics and Markdown from saved evidence without inference or regrading.
eval-report $saved $output:
    node apps/executor/tests/eval/report.ts "$saved" "$output"

# Check selected retained acceptance offline, keeping a report even on refusal.
eval-verify $saved $output:
    node apps/executor/tests/eval/report.ts "$saved" "$output" --require-pass

# Retain a private hosted-verification bundle; no authentication or deployment.
hosted-prepare output:
    node apps/executor/tests/hosted/prepare.ts {{quote(output)}}

# Retain a production-backed candidate for the existing protected test Worker.
hosted-product-prepare output:
    node apps/executor/tests/hosted/prepare.ts {{quote(output)}} product

# Verify one deployed private candidate using HOSTED_* environment settings.
hosted-verify output:
    node apps/executor/tests/hosted/verify.ts {{quote(output)}}

# One-time installed-app consent; credentials stay outside the repository.
oauth *args:
    node apps/executor/tests/support/oauth.mjs {{args}}

# Install only client/grant/account secrets needed by the live GitHub job.
github-secrets:
    node .github/secrets.mjs

build:
    node apps/executor/tests/run.mjs build

# Publish the unchanged checkout using deployment environment settings.
deploy *args:
    node apps/executor/deploy.mjs {{args}}

# Publish the auth gateway using existing KV, bucket and executor resources.
deploy-gateway *args:
    node apps/gateway/deploy.mjs {{args}}

dev:
    node_modules/.bin/wrangler dev --config apps/executor/wrangler.jsonc --var GATEWAY_ONLY:false
