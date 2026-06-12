# prole-site

Static landing page for **Prole** — the native macOS snip-to-Claude app. Serves the marketing
one-pager and the downloadable `.dmg`. Hosted on the existing Hetzner + Coolify infra.

## Layout

```
index.html      # the one-pager (hero, how-it-works, install)
styles.css      # all styling (no framework, no build step)
assets/         # icon + any screenshots
nginx.conf      # static serving + /download artifact location
Dockerfile      # nginx:alpine — what Coolify builds
```

The download button links to the **relative** path `/download/Prole.dmg`, so it works under
Coolify's generated URL today and unchanged once a real domain is attached.

## How the DMG gets served

The `.dmg` is a rebuilt binary and is **never committed to git**. nginx serves `/download/` from
`/srv/prole-releases/` inside the container, which Coolify bind-mounts from the host directory
`/data/prole-releases`. The release script uploads the DMG there:

```sh
# from apps/prole/ — builds locally (ad-hoc signed) and uploads
./scripts/release.sh
```

See `apps/prole/scripts/release.sh`.

## Local preview

```sh
pnpm --filter prole-site preview     # docker build + run on http://localhost:8080
# drop a file at ./_local-download/Prole.dmg and mount it to test /download:
docker run --rm -p 8080:80 \
  -v "$PWD/_local-download:/srv/prole-releases:ro" prole-site
```

## Coolify deploy (done once, at deploy time)

1. **New Application** → Build Pack: **Dockerfile**, Base Directory: `apps/prole-site`.
2. **Persistent Storage** → bind mount: host `/data/prole-releases` → container
   `/srv/prole-releases` (read-only).
3. No custom domain for now — use Coolify's generated URL. When DNS is ready, attach the domain;
   nothing in this site needs to change (all links are relative).
4. On the host: `mkdir -p /data/prole-releases` before the first release upload.
