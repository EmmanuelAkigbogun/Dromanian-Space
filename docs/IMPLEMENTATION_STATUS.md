# Implementation status

The repository now targets the standalone server architecture only.

Implemented in the product-repair release:

- transactional company-only signup, first-admin enforcement, canonical
  workspace enrollment and automatic General-channel membership;
- streamed filesystem storage with compensating DB/file operations, checksums,
  idempotency, byte ranges, HEAD, expiring signed links and reconciliation;
- authenticated audience-scoped SSE topics and server-owned call/signaling
  endpoints with reconnect persistence, deduplication and stale cleanup;
- 1–6 participant WebRTC mesh negotiation and short-lived Coturn credentials;
- self-hosted Coturn service and restricted relay range;
- encrypted platform-admin provider-key management with no secret readback;
- dark-professional design tokens, shared interaction states and lazy-loaded
  feature/call bundles;
- strict zero-warning lint, patched React Router, safe Mammoth transitive
  override, and repaired Windows PostgreSQL test discovery;
- age-encrypted database/files/config backup, retention, monitoring, rclone
  replication and isolated restore tooling for the standalone stack.

Production rollout remains intentionally gated on real deployment secrets,
DNS/firewall/TURN certificates, a current encrypted backup and a successful
restore drill. See [COOLIFY_SETUP.md](COOLIFY_SETUP.md).
