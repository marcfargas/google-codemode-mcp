set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# Run the credential-free GitHub workflow locally in act.
check:
    node tests/act.mjs check

# Run the workflow's checks directly on this machine.
verify:
    node tests/run.mjs check

# Run the credentialed Gmail workflow locally in act.
live:
    node tests/act.mjs live

# Verify Drive files, conditional-option refusal and explicit pagination.
live-drive:
    node tests/act.mjs live-drive

# One on-demand agent case; an optional second trial observes caching.
eval $profile $model $proxy_url $output $repeats='1':
    node tests/eval/act.mjs

# Required Sonnet/Sol pair by default; select all for the six-model comparison.
eval-matrix $profile $proxy_url $output $selection='required':
    node tests/eval/act.mjs

# Six independent Gmail cases, one attempt per selected model and case.
eval-gmail $proxy_url $output $cases='all' $selection='required':
    profile=gmail node tests/eval/act.mjs

# Two independent Drive cases after just oauth --drive.
eval-drive $proxy_url $output $cases='all' $selection='required':
    profile=drive node tests/eval/act.mjs

# Prove isolated runner/file/MCP behavior with synthetic responses only.
eval-preflight $output:
    profile=gmail proxy_url=http://127.0.0.1:1 selection=required preflight_only=true node tests/eval/act.mjs

# One optional native Codex/Sol read-search attempt; not the required matrix.
eval-native-gmail $proxy_url $output:
    profile=gmail model=gpt-6.1-sol runner=codex node tests/eval/act.mjs

# Exercise native Codex with inert provider/MCP responses and no credentials.
eval-native-preflight $output:
    profile=gmail model=gpt-6.1-sol runner=codex proxy_url=http://127.0.0.1:1 preflight_only=true node tests/eval/act.mjs

# Regrade one retained trial without Google or model requests.
eval-regrade $saved $output:
    node tests/eval/regrade.ts "$saved" "$output"

# Retain a private hosted-verification bundle; no authentication or deployment.
hosted-prepare output:
    node tests/hosted/prepare.ts {{quote(output)}}

# Retain a production-backed candidate for the existing protected test Worker.
hosted-product-prepare output:
    node tests/hosted/prepare.ts {{quote(output)}} product

# Verify one deployed private candidate using HOSTED_* environment settings.
hosted-verify output:
    node tests/hosted/verify.ts {{quote(output)}}

# One-time installed-app consent; credentials stay outside the repository.
oauth *args:
    node tests/support/oauth.mjs {{args}}

# Install only client/grant/account secrets needed by the live GitHub job.
github-secrets:
    node .github/secrets.mjs

build:
    node tests/run.mjs build

# Publish the unchanged checkout using deployment environment settings.
deploy *args:
    node deploy.mjs {{args}}

dev:
    node_modules/.bin/wrangler dev
