set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# Run the credential-free GitHub workflow locally in act.
check:
    node .github/act.mjs check

# Run the workflow's checks directly on this machine.
verify:
    node .github/run.mjs check

# Run the credentialed Gmail workflow locally in act.
live:
    node .github/act.mjs live

# Verify Drive bytes and native rename through the built Worker.
live-drive:
    node .github/act.mjs live-drive

# One on-demand agent case; an optional second trial observes caching.
eval $profile $model $proxy_url $output $repeats='1':
    node .github/eval/act.mjs

# Required Sonnet/Sol pair by default; select all for the six-model comparison.
eval-matrix $profile $proxy_url $output $selection='required':
    node .github/eval/act.mjs

# Six independent Gmail cases, one attempt per selected model and case.
eval-gmail $proxy_url $output $cases='all' $selection='required':
    profile=gmail node .github/eval/act.mjs

# Two independent Drive cases after just oauth --drive.
eval-drive $proxy_url $output $cases='all' $selection='required':
    profile=drive node .github/eval/act.mjs

# Prove isolated runner/file/MCP behavior with synthetic responses only.
eval-preflight $output:
    profile=gmail proxy_url=http://127.0.0.1:1 selection=required preflight_only=true node .github/eval/act.mjs

# Regrade one retained trial without Google or model requests.
eval-regrade $saved $output:
    node .github/eval/regrade.ts "$saved" "$output"

# Retain a private hosted-verification bundle; no authentication or deployment.
hosted-prepare output:
    node .github/hosted/prepare.ts {{quote(output)}}

# Verify one deployed private candidate using HOSTED_* environment settings.
hosted-verify output:
    node .github/hosted/verify.ts {{quote(output)}}

# One-time installed-app consent; credentials stay outside the repository.
oauth *args:
    node .github/oauth.mjs {{args}}

# Install only client/grant/account secrets needed by the live GitHub job.
github-secrets:
    node .github/secrets.mjs

build:
    node .github/run.mjs build

# Publish the unchanged checkout using deployment environment settings.
deploy *args:
    node .github/deploy.mjs {{args}}

dev:
    node_modules/.bin/wrangler dev
