# Production notes — scorecard-be

Host: `35.253.220.189`. Port `3005`.

This branch carries the SAME CODE as `sandbox`. Only `.env.prod` and
`docker-compose.yml` differ, and they are the only files that should ever
diverge between the two branches.

## Before first boot

Every value marked `CHANGEME_set_on_the_prod_server` in `.env.prod` must be
replaced on the server. The app will not work — and in most cases will not
start — until they are.

**`JWT_ACCESS_SECRET` must be the SAME STRING across every prod service**, and
must differ from sandbox. It is a shared HS256 secret: the authenticator signs
tokens with it and every other service verifies with it. If prod reuses the
sandbox secret, a sandbox token is accepted in production, which is the whole
reason these environments are being split.

## Image tag

`1.0.0-prod`, not `1.0.0`. Sandbox builds `1.0.0`; if prod used the same tag
the two would overwrite each other on Docker Hub and a `docker compose pull`
would fetch whichever was pushed last.

## Two things still open

**1. The database is shared with sandbox.** `DB_HOST` is unchanged at
`35.216.155.219`, because `35.253.220.189` is a web server with no database on
it. Until a prod database exists, this environment reads and writes the same
rows sandbox does. Splitting it means changing `DB_HOST` / `DB_NAME` and
nothing else in this repo.

**2. There is no domain yet.** Everything addresses the box by IP over plain
HTTP. When DNS and certificates land, the URLs in `.env.prod` change together —
they have to agree or the browser fails on CORS rather than on anything useful.
A front end additionally needs rebuilding, because Vite bakes `VITE_*` in at
build time.
