# Self-hosting map

Dromanian Space is a single-server, self-hosted product. Its browser talks only
to the same-origin API; no third-party backend SDK, hosted auth service or
public database credential is shipped to users.

| Area | Implementation |
| --- | --- |
| Production stack | Root `docker-compose.yml` |
| Database | PostgreSQL 17 + pgvector on `/srv/app-data/dromanian-space/postgres` |
| Data API | Private PostgREST behind the application API |
| Authentication | Server sessions and local `auth` tables |
| Drive bytes | `/srv/cloud-data/dromanian-space/storage` |
| Realtime | Authenticated same-origin SSE |
| Calls | Browser WebRTC with server signaling and self-hosted Coturn |
| Backups | age-encrypted logical DB/files/config archive plus rclone replication |

Start with [COOLIFY_SETUP.md](COOLIFY_SETUP.md). Recovery is documented in
[DISASTER_RECOVERY.md](DISASTER_RECOVERY.md), and provider-key handling in
[AI_PROVIDERS.md](AI_PROVIDERS.md).
