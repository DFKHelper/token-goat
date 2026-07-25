# Deployment Guide

Synthetic fixture for the token-savings regression benchmark. This document
has several unrelated sections so the full file is much larger than any
single heading a surgical `section` read would return.

## Overview

This guide walks through installing, configuring, and deploying the sample
service to a staging environment. It assumes a POSIX shell and a recent
Node.js runtime are already available on the target machine.

## Prerequisites

- Node.js 20 or newer
- A POSIX-compatible shell
- Network access to the internal package registry
- An account with deploy permissions on the staging cluster

Make sure `node --version` and `npm --version` both resolve before
continuing, and confirm you can reach the internal registry with a simple
`npm ping`.

## Installation

Clone the repository, then install dependencies with the project's lockfile
respected:

```
git clone git@example.com:acme/sample-service.git
cd sample-service
npm ci
```

Verify the install succeeded by running the test suite once:

```
npm test
```

## Configuration

This is the target section for the token-savings benchmark's `section`
measurement -- a small, self-contained heading inside a much larger
document.

Configuration lives in `config/staging.toml`. The important keys are:

- `service.port` -- the HTTP port the service listens on (default `8080`)
- `service.log_level` -- one of `debug`, `info`, `warn`, `error`
- `database.url` -- connection string for the staging Postgres instance
- `cache.ttl_seconds` -- how long cached responses stay valid

Copy `config/staging.example.toml` to `config/staging.toml` and fill in the
real values before deploying.

## Building

Run the production build, which type-checks and bundles the service:

```
npm run build
```

The build artifact is written to `dist/` and should not be committed.

## Deploying

Deploys are triggered via the internal CLI:

```
deploy-tool push staging --artifact dist/
```

Watch the rollout status until it reports `healthy`, then run the smoke
tests against the staging URL.

## Rollback

If a deploy introduces a regression, roll back with:

```
deploy-tool rollback staging --to-previous
```

Rollbacks are near-instant since the previous artifact stays cached on the
deploy target for 24 hours.

## Troubleshooting

Common issues and their fixes:

- **Service fails to start**: check `service.port` isn't already bound by
  another process.
- **Database connection errors**: confirm `database.url` matches the
  staging credentials, not production.
- **Stale cached responses**: lower `cache.ttl_seconds` temporarily and
  redeploy.

## Support

For anything not covered here, reach out in the `#platform-support`
channel with the deploy ID and a description of the issue.
