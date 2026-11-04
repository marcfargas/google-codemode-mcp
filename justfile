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

# One-time installed-app consent; credentials stay outside the repository.
oauth *args:
    node .github/oauth.mjs {{args}}

# Install only client/grant/account secrets needed by the live GitHub job.
github-secrets:
    node .github/secrets.mjs

build:
    node .github/run.mjs build

dev:
    node_modules/.bin/wrangler dev
