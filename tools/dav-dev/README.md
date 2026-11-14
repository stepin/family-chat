# tools/dav-dev

WebDAV servers in Docker for development and tests (docs/PLAN.md, section 10).

| Port | Server | CORS |
|---|---|---|
| 18080 | Apache mod_dav, Basic on every method (like a router's built-in WebDAV) | none |
| 18081 | dufs 0.47 with `--enable-cors` | `*`, no Max-Age |
| 18082 | nginx recipe from `docs/recipes/nginx` in front of 18080's server | per recipe |
| 18083 | Caddy recipe from `docs/recipes/caddy` in front of 18080's server | per recipe |

Account everywhere: `fc` / `secret`; chat folder: `/family-chat/`. The Apache account also sees `/other/`, the dufs
account sees only `/family-chat/`.

```bash
pnpm dav:up      # start and wait until every server answers
pnpm dav:down    # stop and delete the data volumes
```

The client origin allowed by the recipes is `http://localhost:4173` (vite preview); override with
`FC_CLIENT_ORIGIN=... pnpm dav:up`.

Used by `pnpm test:integration` (`packages/core`, Storage against every server) and `pnpm test:e2e` (`apps/web`,
the probe in Chromium, Firefox and WebKit from another origin). The e2e global setup starts the servers if they are
not running.

The "capricious router" modes from the plan (connection limits, non-atomic PUT, 207 on DELETE, slow first byte,
HTML instead of a listing) start in M1; some of them already exist in the in-memory `FakeDav`
(`packages/core/src/testing/fake-dav.ts`).
