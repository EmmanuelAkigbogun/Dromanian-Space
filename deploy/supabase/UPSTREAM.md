# Vendored Supabase self-hosting files

Source: [supabase/supabase](https://github.com/supabase/supabase) at commit
`ff80bb14991e68667c04f74248b954e8babe6fde` (`docker/`, 2026-09-30), Apache License 2.0.

`docker-compose.yml` is upstream's `docker/docker-compose.yml` with the changes marked
`Dromanian:` (data on `/srv` disks with a mount guard, no public database ports, private
network alias, Traefik labels for the browser APIs only, bounded logs, asymmetric keys
enabled, phone sign-up off). Images are unchanged:

Coolify converts repository-relative bind mounts into persistent application paths. The local
`Dockerfile` therefore creates thin image layers containing the vendored SQL, Envoy, Functions,
Studio and Supavisor files. Their bases remain the exact pinned upstream images below; only
version-controlled configuration is added.

| Service | Image |
| --- | --- |
| db | `supabase/postgres:17.6.1.136` |
| auth | `supabase/gotrue:v2.196.0` |
| rest | `postgrest/postgrest:v14.17` |
| realtime | `supabase/realtime:v2.134.10` |
| storage | `supabase/storage-api:v1.74.0` |
| imgproxy | `darthsim/imgproxy:v3.31.4` |
| meta | `supabase/postgres-meta:v0.99.0` |
| functions | `supabase/edge-runtime:v1.76.2` |
| supavisor | `supabase/supavisor:2.9.12` |
| api-gw | `envoyproxy/envoy:v1.39.1` |
| studio | `supabase/studio:2026.09.07-sha-7996410` |

Not included: the optional logging/analytics stack (`docker-compose.logs.yml`, which mounts the
Docker socket), the Kong, Caddy and Nginx proxy overrides, and the S3/MinIO overrides.

## Files copied unchanged

`tests/unit/deploy.test.ts` checks these checksums, so an accidental edit fails the tests.

```text
afeddcb0c4e2f6a4ee5775a357d90ae7e804a6ff3e5160725468ce7ac0daad0f  utils/add-new-auth-keys.sh
6299efc24ce94d771ca4abb8ac96b67624cc4ac9a4b13ee0c2a8f0071aa3d619  utils/generate-keys.sh
1d7514b891370ed27c25911df008887402e16ab09273e6e433225bb7f09f7905  volumes/api/envoy/cds.yaml
8a0c9503764de32ba39e0d81e73629457b13ec42ef19897e30e4918c996d0508  volumes/api/envoy/docker-entrypoint.sh
3697f23b0be9ec5b829f937c600eb9b878f1f778ab510b42ad5e4f14742447e9  volumes/api/envoy/envoy.yaml
c0c9218d57df78df195958d74c0501184a1db3fd451b2d2ed1ec649ef92420e2  volumes/api/envoy/lds.template.yaml
9dce462adc04137d6afabcf28efa60a6c355270a4b32d7af58891ac4eb964c5f  volumes/db/_supabase.sql
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  volumes/db/init/data.sql
c1d3f5c01e44646c2e533c5a1c111821cc49cb5a4c2534e08cddad61d8fb0339  volumes/db/jwt.sql
f0463ce5030907acef49326d2bffd36002df0718035071be7c99bd7fc897c63d  volumes/db/logs.sql
df97ebe148d94cfb92a5e37ebf972dfd496be195f0915ecf14396b2cf50efecb  volumes/db/pooler.sql
7e9e442e7fc4dae05544c07b67bede37a00d84644304dfce4d937134cb4c8f88  volumes/db/realtime.sql
3ad717b225daa38aa982da26750f35641eb404e1eb5e69a763c22236ab96c1b2  volumes/db/roles.sql
05a61316b899374253891cbba66ce073d9273f33983c3f47961eda3aa26c2823  volumes/db/webhooks.sql
a9a29da36c2576f755dd868b9f553a02afdf7d7bccf52e97e65c7f68cf36bfef  volumes/functions/deno.jsonc
ed402c31abf346198d71cc7bab3b7eead03b91d6b9d638b30fc5e5fada25802b  volumes/functions/main/index.ts
d844e49f8915021ccbf6af6b769fef7909a723346bfc8f94ddb0433a328e49b1  volumes/pooler/pooler.exs
```

`volumes/functions/fetch-link-preview/index.ts` is this application's own Edge Function, a copy
of `supabase/functions/fetch-link-preview/index.ts` (the test checks that they stay identical).

## Updating to a newer Supabase release

1. Read upstream's `docker/CHANGELOG.md` and `docker/versions.md` between the two commits.
2. Download the new `docker/` tree, diff its `docker-compose.yml` against the previous upstream
   copy, and carry the changes into this file while keeping every `Dromanian:` change.
3. Replace the vendored files, update the checksums above and the commit hash.
4. Never change the `db` image's PostgreSQL major version in place: follow upstream's upgrade
   procedure (`utils/upgrade-pg17.sh` style) on a restored copy first.
5. Rehearse on an isolated stack restored from a production backup (docs/DISASTER_RECOVERY.md),
   then take a fresh backup and redeploy production.
