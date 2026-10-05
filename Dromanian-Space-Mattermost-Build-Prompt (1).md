# Dromanian Space — implementation prompt

Copy this entire document into the coding agent working in the repository, or attach it and ask the agent to implement it. Also attach `Dromanian-Space-Self-Hosting-Addendum.md` for the deployment layout. This is an implementation brief, with repository observations verified at commit `c8ce62112bdca58f6d3bc9956a0e1ff4bdafa095`. Reconcile those observations with the checkout you actually receive.

---

## 1. Your assignment

Transform the existing application at https://github.com/EmmanuelAkigbogun/Dromanian-Space into a complete, multi-tenant collaboration workspace: **Mattermost-inspired team communication, an integrated shared drive, and a dashboard of useful AI agents.** Retain a lightweight HubSpot-inspired CRM as a supporting module, connected to the same people, files, tasks, and conversations.

Implement the product in this repository. Inspect, plan, write code, migrate the database safely, verify complete user journeys, and prepare it for a Coolify-managed deployment on my server. Continue beyond scaffolding until the implemented journeys work. A plan, static dashboard, collection of disconnected mock screens, or renamed navigation is not a completed delivery.

Use Mattermost as the primary interaction reference. Use the earlier Sintra direction for the approachable catalog of specialist assistants. Keep the Dromanian Space identity and the existing application's useful behavior. Build an original interface around these references.

The desired everyday experience is: a team discusses work in a channel, shares a file from its drive, asks an agent about the discussion and file, reviews a grounded response, and saves the resulting document or creates an assigned task without losing context.

Make reasonable implementation decisions and record them. Do not ask about routine component choices, naming, spacing, or folder organization. Respect actual approval boundaries, existing user work, and infrastructure access controls. If a credential or external service is unavailable, complete the available implementation, provide an honest configuration state, and identify the exact remaining setup step. Never substitute simulated success for a real integration.

## 2. Start from the actual repository

Read `agent.md`, `prd.md`, `masterprompt.md`, `README.md`, the package manifest, routing, providers, schema, and any additional applicable repository instructions before changing code. Inspect the working tree and preserve unrelated changes.

The old product documents describe a communication-first scope and defer AI, documents, and CRM. **This request explicitly authorizes those product additions.** Update obsolete scope statements narrowly so the repository describes the new product. Preserve engineering, security, and data-handling instructions; do not treat a scope expansion as permission to remove safeguards.

Verified starting points to recheck:

| Existing area | Starting point | Implementation consequence |
|---|---|---|
| Frontend | React 19, TypeScript, Vite, React Router | Extend this application; retain the Vite architecture. |
| Styling | CSS Modules and CSS custom properties; `@/` import alias | Reuse tokens and established components. Do not introduce a parallel Tailwind/shadcn design system. |
| Data | Supabase client, TanStack Query, existing providers and realtime features | Extend existing hooks and data contracts; keep tenant-aware cache keys. |
| Routing | `src/App.tsx` | Audit route guards and deep links while adding modules. |
| Dashboard | `src/app/routes/Home/Home.tsx` | Existing tasks, projects, channels, and member summaries provide a foundation. |
| AI | `/ai` currently renders a coming-soon placeholder in `src/App.tsx` | Replace it with a persisted agent product and real backend execution. |
| Files | `src/app/routes/Files/Files.tsx` queries the signed-in user's `file_attachments`, with workspace filtering | Upgrade an attachment browser into a workspace drive with independent file ownership and sharing. |
| File rendering | `FilesGrid.tsx`, `src/lib/message/attachment.ts`, `src/hooks/useSignedUrls.ts` | Reuse preview and upload behavior where appropriate; inspect object paths and reference ownership before migrating. |
| Messaging | Channels, DMs, threads, reactions, saved/pinned messages, presence, calls, scheduled messages | Preserve and integrate these capabilities. Validate behavior rather than assuming every route works. |
| DMs | `src/lib/conversation/conversation.ts` stores workspace-scoped conversations backed by private channels | Preserve participant privacy and the current data relationships. |
| Productivity | Existing tasks, projects, calendar, and automations | Extend these modules instead of creating duplicate task or automation engines. |
| Authorization | `src/lib/workspace/permissions.ts` currently has owner, admin, and member roles | Extend capabilities deliberately and enforce them in the backend. |
| Database | `supabase/SQL/all/all.sql` contains accumulated schema and functions | Establish additive, ordered migrations and reconcile the actual deployed state. |
| Scheduling | `src/App.tsx` has browser polling; SQL also defines scheduled-message cron processing | Audit both paths for duplicate execution, failure recovery, and attachment loss before extending automation. |
| Hosting | `vercel.json` currently rewrites non-asset routes to the SPA | Ensure new API routes are not rewritten to HTML. |
| Checks | `npm run build` runs TypeScript and Vite; `npm run lint` uses Oxlint | Establish baseline results and preserve existing package conventions. |

Do not execute destructive reset SQL or delete existing users, workspaces, files, or messages. Do not rewrite the application from scratch merely to fit a preferred starter template. Verify present-day package and hosting APIs against official documentation when implementation requires it.

## 3. Reference hierarchy and product boundaries

Reference links:

- Mattermost navigation: https://docs.mattermost.com/end-user-guide/collaborate/navigate-between-channels
- Mattermost sidebar organization: https://docs.mattermost.com/end-user-guide/preferences/customize-your-channel-sidebar
- Mattermost agent interactions: https://docs.mattermost.com/end-user-guide/agents
- Existing repository: https://github.com/EmmanuelAkigbogun/Dromanian-Space

Take inspiration from Mattermost's separation of channels and direct conversations, personal sidebar organization, quick channel navigation, threaded replies, and contextual agent access. These are interaction references, not instructions to install or fork the Mattermost backend. The shared drive, dashboard composition, and CRM described below are requirements for our product, not claims about Mattermost's feature set.

Keep the required stack: **React + TypeScript + Vite; Supabase Auth, Postgres, Storage, and Realtime; a Node API and background worker hosted in Docker through Coolify.** Use the existing workspace as the tenant boundary. A user can belong to several workspaces. Do not require a new organization hierarchy just to implement multi-tenancy. Parent organizations and centralized billing can be added later if genuinely needed.

Priorities are collaboration, drive, and AI. Keep existing tasks/projects/calendar/automation usable. Add the CRM after the core workflow is connected. Defer native desktop clients, a full Office editor, public file-link distribution, marketplace billing, marketing-email campaigns, and arbitrary autonomous code execution. Do not add buttons implying those features exist.

## 4. Application shell and navigation

Create one coherent application shell with four working regions:

1. **Compact application rail, approximately 60–68 px:** workspace switcher; Home; Chat; Drive; Agents; Tasks/Projects; CRM; activity; settings; profile. Use icons with accessible labels, tooltips, active states, and restrained unread indicators. Keep less-used existing modules available under a clear More menu.
2. **Context sidebar, approximately 240–280 px:** changes with the active module. Chat shows conversations; Drive shows folders and views; Agents shows specialists and recent sessions; CRM shows record types and saved views. It must not become one long list containing every application feature.
3. **Main working area:** full-height content, local header, primary action, and appropriate scrolling. Conversation scrolling must not move the entire shell.
4. **Optional right panel, approximately 360–440 px:** a thread, file details, record details, or contextual assistant. Reuse existing thread infrastructure. Manage these modes explicitly so multiple drawers do not cover each other. Persist useful draft and panel state when switching context.

Provide global search, a workspace indicator, a command palette, notification access, and a quick-create menu. Quick create offers a message, channel, file upload, document, task, and contact when authorized. Search and shortcuts must resolve to a real object with an addressable URL.

Use a restrained, dense collaboration interface: clear typography, subtle borders, strong focus states, readable message text, and consistent spacing. Preserve the current theme system and support both dark and light appearances if the existing system provides them. Agent cards may have distinct colors and small avatars, but the product should feel like a daily work application.

Below desktop width, collapse the context sidebar into a drawer. On narrow mobile screens show one primary surface; open threads, previews, and agent details as dedicated views. Preserve composer drafts and scroll position. Support keyboard navigation, reduced motion, readable contrast, screen-reader names, and focus restoration after dialogs close.

Persist navigation preferences per user and workspace. Switching workspace must close or reauthorize contextual panels, reset relevant selections, unsubscribe from old realtime topics, and avoid displaying another workspace's cached content.

## 5. Home: the team and AI dashboard

Make Home useful from the first real data entry. Its header contains the workspace name, a short greeting, a time-range control where relevant, and quick actions. Arrange the page as:

- **Needs attention:** mentions, unread followed threads, assigned tasks due soon, and agent actions awaiting this user's review. Every count opens the underlying filtered records.
- **Your AI team:** responsive grid of specialist cards. Each shows name, job, one short capability statement, availability/configuration status, and a Start action. Support pinning frequently used agents.
- **Continue work:** recent channels, recently opened files, and unfinished agent conversations, scoped to the current user.
- **Team activity:** a paginated feed of relevant shared documents, completed work, and published agent outputs. Private events never appear here solely because someone is an administrator.
- **Work summary:** existing task/project metrics and, after CRM implementation, an optional pipeline summary. Use real queries and accurately label currency and date scope.

The dashboard needs loading, empty, failure, and partially configured states. A new workspace should show useful onboarding actions: invite a teammate, create a channel, upload a file, and configure AI. Do not display invented activity, cost savings, or productivity percentages. Clearly separate developer demo data from real workspaces.

## 6. Chat: the collaboration backbone

Evolve existing messaging into a polished Mattermost-inspired experience.

**Conversation sidebar:** Unreads, Threads, Mentions, Saved, Favorites, public/private channels, and direct/group conversations. Add personal collapsible categories, channel search, create/join actions, unread counts, mute controls, and drag/reorder where practical. Category changes affect the user's navigation, not the channel's permission model.

**Channel header:** channel name, privacy indicator, topic, members, search-in-channel, pinned resources, notification settings, and contextual assistant action. Public means accessible to the appropriate workspace members, never public on the internet. Preserve existing join/read semantics unless a documented change is needed.

**Message timeline:** stable pagination, date separators, unread marker, edited/deleted state, author identity, reactions, attachments, reply counts, saved/pinned actions, and permalinks. Preserve existing editing, forwarding, scheduling, and calls where available. Optimistic sends need pending, sent, and failed states with safe retries and deduplication.

**Composer:** readable formatting, mentions, emoji, drag/drop uploads, Drive attachment picker, reply context, keyboard send preferences, and a visible destination. Keep drafts per workspace and conversation. Choosing a Drive item references the existing file; it must not upload another copy by default.

**Right-side thread:** parent message, replies, thread composer, follow/unfollow, and optional AI summary. Thread responses must be associated with the correct parent. A global Threads view should expose conversations the user follows and their unread state.

**Channel resource tabs:** Messages, Files, and Pinned; optionally Tasks when linked tasks exist. Files lists resources shared in that channel subject to file permission checks. A channel file view is a contextual view of Drive resources, not a second storage system.

**AI entry points:** Ask AI about the channel, summarize a selected thread, and explicitly mention an available agent. Resolve mentions to agent identities and a bounded context snapshot. Prevent agent-to-agent reply loops and duplicate runs when realtime events repeat. No workspace-wide background reading or automatic replies by default.

For shared replies, source access must be compatible with the destination audience. An agent must not publish information from a private DM or restricted document into a broader channel simply because its requester can read both. Offer a private result when the broader audience lacks access.

Presence and typing are ephemeral. Persisted messages are the source of truth. Reconnect by fetching missed records with cursors and deduplicating IDs; do not depend on an uninterrupted websocket stream.

## 7. Drive: real shared documents and files

Replace the attachment-only Files experience with an independent Drive. Retain old URLs through compatible routes or redirects.

**Drive sidebar:** Workspace files, My files, Shared with me, Recent, Starred, Trash, plus accessible folder trees. Define these precisely: Workspace files are resources explicitly shared with the workspace; My files are owned by the user in this workspace; Shared with me includes grants through users, channels, and projects. Ownership alone does not determine all visibility.

**Main browser:** breadcrumbs, search, upload button, New folder, New document, grid/list toggle, sortable name/type/owner/modified/size columns, filters, and multi-select. Context menus support rename, move, favorite, share, copy internal link, download, view details, and trash when authorized. Support keyboard alternatives to drag/drop.

**Upload flow:** independent of posting a message; multi-file selection, progress, cancel, retry, size/type validation, and clear errors. Finalize metadata and object references reliably; clean up abandoned uploads. Show extraction/indexing separately from upload completion.

**Preview/details:** image preview; PDF viewer; safe text/Markdown view; paginated CSV preview; downloadable fallback for unsupported formats. The right panel includes owner, location, access, linked channels/projects/CRM records, version history, comments, activity, and AI indexing status. Render untrusted HTML and SVG safely; never execute uploaded scripts.

**Documents:** create a simple internal text/Markdown document with title, editor, autosave state, version history, comments, and sharing. Store structured metadata and revisions independently of messages. Handle simultaneous edits through optimistic concurrency and a conflict/reload/duplicate flow. Do not imply Google Docs-style simultaneous editing unless you actually implement it.

**Sharing dialog:** named users, a channel, project, or workspace; viewer/commenter/editor access as supported; inherited versus direct permissions; who can manage sharing; removal of grants; and preview of the resulting audience. Copying an internal link does not grant access. A recipient without access sees a generic request-access flow without leaked document titles or snippets. An owner or authorized manager receives access requests.

**Folder permissions:** implement one documented inheritance model. Default to inheriting parent permissions; allow an explicitly restricted folder only if the backend and UI can correctly represent and enforce it. Moving a file or folder must preview meaningful access changes, reject cycles, and preserve same-workspace ancestry. New children must receive the intended audience consistently.

**Channel sharing:** attaching a file grants no silent extra access. Where the sharer is authorized, offer a clear action to grant the channel an appropriate role; otherwise block the incompatible share or let it appear as an inaccessible internal link. Channel grants follow membership, including future joins and removals. Show this in the sharing dialog.

**Versioning and deletion:** a logical file has immutable content versions and a current-version pointer. Record which version an AI citation used. A message attachment refers to the logical resource and, where appropriate, a pinned version. Deleting a message must not delete a file used elsewhere. Trashing removes normal access and retrieval; restoration respects current permissions. Permanently delete storage objects only when retention requirements and remaining references allow it.

**Legacy migration:** existing `file_attachments` are tied to messages, and forwarded attachments can reuse an object path. Inventory these relationships. Introduce logical resources and link legacy attachment rows through an additive, rerunnable backfill. Preserve private channel and DM access; never make every old upload workspace-visible. Distinguish external link attachments from uploaded binary files. Report unresolved/ambiguous rows instead of guessing or deleting them.

Start with authenticated sharing only. Use private Supabase buckets and short-lived signed URLs. Persist bucket/object identifiers rather than expiring URLs. Authorize URL issuance and storage reads; explain that already issued URLs may work until expiry, and use an authorized download proxy if immediate revocation is required.

## 8. Agents: conversations, tools, and saved outputs

Use one shared execution architecture with different agent configurations, instructions, tool allowlists, and knowledge scopes. The following **twelve role equivalents** cover Sintra's complete core roster. Sintra's names below identify the product reference; give the agents in this application original names, visual identities, and instructions. Do not imply they are licensed Sintra employees or copy Sintra assets. A role profile does not require its own model process.

Seed twelve workspace-configurable, callable specialists. Each row names real data and tools needed to deliver a useful workflow, with a visible setup state when an external connection is absent:

| Sintra role reference | Agent in this product | First useful workflow and required tools |
|---|---|---|
| Buddy — business development | Strategy & Growth | Read permitted CRM and project summaries plus market notes in Drive; draft a growth plan with cited assumptions and proposed tasks. |
| Cassie — customer support | Support | Retrieve authorized FAQ/policy files and support conversations; draft a cited reply and, when a real inbox or ticket connector exists, propose a reply or ticket update for approval. |
| Commet — e-commerce | Commerce | Analyze imported product/order data or a configured commerce connection; draft product copy and an inventory or campaign report. A Medusa integration can be added for an owner's store, but an unconfigured store must never appear connected. |
| Dexter — data analysis | Analyst | Parse permitted CSVs and run parameterized, read-only workspace aggregates; explain calculations with filters, date ranges, and sources, then save a report. |
| Emmie — email marketing | Email Marketing | Use brand guidelines, opted-in contact segments, and approved templates to draft an email campaign. Add a properly authorized email platform connection before enabling send/schedule actions. |
| Gigi — personal development | Personal Coach | Use the requesting user's private goals, calendar, and tasks to propose routines and reminders. Personal reflections default to private and are not shared with workspace members through general knowledge retrieval. |
| Milli — sales | Sales | Read permitted contacts, companies, deals, and relevant documents; draft a deal briefing, call outline, and follow-up, with reviewed CRM updates. |
| Penn — copywriting | Copywriter | Read the workspace brand kit and selected Drive files; draft or revise campaign copy and save an approved version to a document. |
| Scouty — recruiting | Recruiter | Draft job posts and interview plans from an approved job description; read applicant records only when an authorized recruiting module or integration exists. Keep candidate data access restricted. |
| Seomi — SEO | SEO Specialist | Inspect a configured site's accessible pages and metadata plus connected search analytics when available; propose titles, content briefs, and prioritized site changes. |
| Soshie — social media | Social Manager | Draft a channel-specific content calendar and posts from the brand kit. Publishing or scheduling needs an authorized social account connection and review. |
| Vizzy — virtual assistance | Executive Assistant | Summarize the user's permitted inbox/calendar/tasks and offer a daily briefing, meeting preparation, and reviewed event/task changes. |

The UI includes each agent as a full team member: card, detail page, private chat, `@` mention where allowed, stored conversations, source scope, quick tasks, permission-aware actions, activity history, and clear readiness state. Every card launches a real conversation when its shared model provider is configured. Its base workflow should function using native workspace data where the table allows; missing third-party connectors disable only the corresponding connected actions. Agent availability reflects provider, tools, permissions, and knowledge readiness. Do not label the Analyst as capable of arbitrary code execution; use bounded parsing and vetted calculations initially.

Provide an explicit **Team Chat** in the Agents area. A coordinator decomposes a request into bounded tasks for selected specialists, persists task ownership/status/results, and synthesizes an answer with citations and visible authorship. Allow a user to invoke any specialist directly. Prevent recursive delegation and excessive model calls with a depth/step budget. Each specialist receives only the sources and tools the requesting user and destination permit. Actions still require the appropriate approval; delegation cannot expand permissions. Show which specialist did what, and resume the team run after a browser disconnect.

Use a shared workspace knowledge layer for approved Drive documents, brand guidelines, products, CRM, and conversations subject to resource permissions. Personal memory and access-restricted records retain their own scopes. Configure the model/provider at the workspace level with per-role overrides only when justified by capability or cost, and record the actual model used by each run. Keep model routing separate from the agent's identity.

**Agents directory:** grid/list view, name/role search, categories, favorites, status, New agent, and workspace defaults. Distinguish built-in templates from user-created configurations.

**Agent detail:** Overview, Conversations, Knowledge, Tools, Activity, Settings. Overview has description, examples, and Start conversation. Knowledge lists selected sources with indexing state. Tools lists actual available actions and their approval policy. Settings permits authorized users to edit instructions, allowed tools, source scope, default model, and visibility; version configurations so historical runs remain explainable.

**Agent conversation:** persisted addressable thread, streaming response, stop/retry, message editing or explicit new branches, attachments/source picker, visible scope chips, citations, tool-result cards, and generated artifacts. Keep sources and activity available in the right panel. Explain when information is missing or a source could not be read.

Persist conversation and user message before generation starts. Give every run and tool invocation stable IDs. Store output, source references, status, timestamps, model/provider, usage, and errors. Reopening or refreshing must recover the existing run and messages without launching another paid generation. A disconnected stream must not fabricate completion.

Use clear states: queued, running, awaiting approval, completed, failed, cancelled, and interrupted where recovery requires it. Persist recoverable progress and final output. Cancellation should signal the worker/provider and mark subsequent actions as cancelled where they have not started.

**Initial tools:** search authorized workspace records; read selected file/version; read a bounded channel/thread; propose/create a task; draft/create a document; propose a channel message; read/update permitted CRM fields. Implement server-validated schemas and typed results. Add tools incrementally through a registry. A model never receives unrestricted SQL, the service-role key, or arbitrary network access.

Run read-only operations under the requester's current effective access. Require a review card for sending a message, materially changing a record, or making a broader share, unless a specific administrator-configured policy and user authorization already cover that action. Show the exact destination and proposed content/changes. Bind approval to immutable action arguments, actor, workspace, and expiry; edits invalidate approval. Recheck permissions when executing. Use idempotency keys so approval or webhook retries cannot duplicate a task or message.

Show useful progress such as which sources were searched and which action awaits approval. Do not expose private chain-of-thought. Avoid fabricated step histories or token counts; if pricing is unknown, show usage without inventing a cost.

Keep provider credentials server-side. Support one real provider end to end first, with a provider adapter so another can be added later. A workspace's configured model must be available to its credentials. Apply user/workspace quotas, bounded context, execution timeouts, concurrency limits, and a maximum tool-step count. Meter usage in an auditable ledger and distinguish reservations, completed usage, and failures.

## 9. Knowledge and retrieval

A shared file is not automatically available to every agent. Knowledge eligibility, file permissions, the agent's configured source scope, and the requesting user's access all apply.

Implement this pipeline:

1. A version is uploaded or a document revision is committed.
2. A durable job validates type/size, extracts text, and records extraction metadata.
3. Text is split into bounded chunks with stable file/version/location references.
4. Embeddings are generated using a configured compatible model and stored with model/dimension metadata.
5. Retrieval searches only the allowed workspace and authorized sources, then returns grounded context and references.
6. Citations open the accessible source at the relevant page, section, or row range where supported.

Initially support text-based PDF, DOCX, TXT, Markdown, and CSV. For scans, encrypted documents, unsupported formats, or extraction failures, show the actual status and a useful explanation. Never mark an unreadable file as indexed. Do not silently truncate a document while presenting the answer as exhaustive.

Use Postgres full-text search and pgvector where appropriate, with authorization applied inside the query/function before unauthorized content can be returned. Do not retrieve cross-tenant chunks and filter them afterward in JavaScript. Use backend permission checks even when the user supplied an explicit source ID.

Store source lineage on generated outputs. Permission changes, membership removal, trash, and version replacement must propagate to retrieval and source visibility. Do not leave stale snippets in search, dashboards, conversation lists, notification previews, or caches. Source-backed private outputs should remain gated by their source access unless an authorized user deliberately publishes a separate reviewed artifact with an explicit audience.

Treat document text, channel messages, and external pages as untrusted context. They cannot override system rules or grant tool permissions. Test a document that says to reveal another workspace's files; the request must remain isolated.

Support retries, failure inspection, reindexing, and cancellation. Keep extraction and embeddings out of browser execution and out of a single long synchronous upload request.

## 10. CRM and existing productivity modules

Keep the earlier HubSpot-inspired requirement as a coherent, smaller CRM, after the core chat/drive/agent workflow works:

- **Contacts:** name, email, phone, company, owner, lifecycle stage, tags, notes, and linked records. Searchable table, filters, saved views, create/edit, and import with validation and duplicate review.
- **Companies:** name, domain, owner, associated contacts/deals, notes, documents, and activity.
- **Deals:** configurable pipelines/stages, board/list views, value, currency, owner, expected close date, associated company/contacts, and linked tasks/files/channels. Dragging a deal between stages must persist and create an activity event.
- **Record detail:** compact property column, central activity timeline, and linked documents/tasks/conversations. Include an agent action to summarize the record or draft follow-up text.

Treat CRM workspace access and ownership consistently. Sum deal values by currency or apply explicitly configured conversion; do not produce a misleading mixed-currency total. Email drafting is available; email sending and inbox synchronization require real configured integrations and are outside the first core delivery.

Reuse existing task, project, calendar, and automation schemas. A task created from a message, file, agent, or deal has the same identity and appears in the existing task interface. Keep source links and permission checks on linked objects. Do not leak a restricted document's title through a publicly visible task.

Extend automation with a few real templates: new file in an approved folder → create a summary draft; selected thread → propose tasks; scheduled project digest → draft a channel update. Use the existing rule and execution-log model where suitable. Document execution identity, destination audience, approval behavior, timezone, and retry policy. AI events must not create infinite automation loops.

## 11. Multi-tenancy and permissions

The security model is workspace membership plus resource-level access. Use current owner/admin/member roles and resource capabilities; do not add a cosmetic guest role unless its restrictions are fully enforced.

Requirements:

- Every new tenant-owned record has an immutable or tightly controlled workspace ID. Shared global catalogs must be explicitly distinguished from tenant data.
- Derive the actor from verified authentication. Treat workspace IDs, resource IDs, and role fields supplied by the browser as untrusted input.
- Enforce reads and mutations through Supabase Row Level Security and authorized server operations. Frontend permission checks improve UX; they are not the boundary.
- Prevent mismatched workspace references with appropriate composite foreign keys/constraints or equivalent database enforcement. An attachment, task, agent run, share, or deal association cannot point across tenants accidentally.
- Check active membership, channel/DM participation, document grants, and operation-specific capability. Being a workspace admin does not automatically expose private DMs or restricted files.
- Secure Realtime topics/subscriptions as well as SQL queries, Storage policies, API endpoints, exports, previews, notifications, and search.
- Review existing `SECURITY DEFINER` functions used by modified flows. Keep the search path controlled, execution privileges narrow, and actor/membership checks explicit. Do not create a universal RLS bypass helper callable by ordinary clients.
- Keep service-role credentials in trusted backend jobs only, with explicit tenant and actor authorization before each operation. Never put them in a `VITE_` variable or a client bundle.
- Include workspace and user where appropriate in query keys. Clear sensitive data and subscriptions on logout; invalidate relevant caches and signed URL caches when access changes.
- Member removal must stop future reads, writes, retrieval, and agent execution under that membership. Reauthorize queued jobs and pending approvals when they run.
- Audit permission changes, role changes, file shares, agent configuration changes, approved mutations, and CRM changes. Avoid logging credentials or full sensitive source content.

Define the permission matrix in a short repository document and make UI and backend behavior agree. Distinguish workspace administration, resource ownership, editor access, and the ability to reshare.

## 12. Data model and migration approach

Inspect the actual schema first and reuse equivalent entities. The following are logical domains, not a demand to create redundant tables with these exact names:

| Domain | Needed relationships and persisted state |
|---|---|
| Existing collaboration | Workspaces, members, channels, channel members, conversations, messages, threads, reactions, receipts, notification preferences. |
| Navigation | User/workspace preferences, personal categories, category memberships, favorites. |
| Drive | Folders, logical resources, immutable versions, document revisions, comments, grants, resource links, access requests, trash metadata. |
| Attachment compatibility | Legacy attachment → logical resource/version mapping, message-resource references, preserved object identifiers. |
| Knowledge | Sources, extracted versions, chunks, embedding metadata, ingestion jobs, extraction errors. |
| Agents | Templates, workspace configurations and versions, tool/source policies, conversations, messages, runs, run events, tool invocations, approvals, outputs/citations, usage. |
| CRM | Contacts, companies, deals, pipelines/stages, associations, activity, saved views. |
| Operational state | Existing automation rules/logs plus durable jobs, attempt history, idempotency keys, audit events. |

Prefer typed associations and explicit constraints over a generic unvalidated object ID. An agent configuration is not a human Supabase Auth account. Model bot authorship so agent posts are clearly attributed and cannot impersonate arbitrary users.

Create ordered SQL migrations in the repository's chosen migration location, preferably `supabase/migrations`, without blindly replaying the consolidated historical SQL against an existing database. Document how to baseline an already provisioned database and how to create a clean local database. Make backfills rerunnable and record progress. Report ambiguities and retain old references until compatibility is verified.

Add relevant indexes for workspace, channel, creation cursor, folder parent, grants, source version, job status, and CRM pipeline queries. Generate/update Supabase TypeScript types. Avoid spreading the repository's existing `as any` pattern into new modules; use typed data-access boundaries.

Separate soft-delete semantics from physical deletion. Define cleanup/retention for file versions, generated outputs, job payloads, and failed uploads. Make recovery and forward-fix instructions concrete; do not promise a destructive down migration can restore deleted data.

## 13. Server execution, background jobs, and deployment

Keep authenticated CRUD in the established Supabase pattern where RLS suffices. Use trusted server endpoints for model calls, secret-bearing integrations, privileged job orchestration, and operations requiring atomic validation. Choose a clear backend boundary and avoid implementing the same API independently in multiple runtimes.

For this implementation, use a Dockerized Node API for application-facing AI and actions, a separately running worker for durable work, self-hosted Supabase for persisted data/storage/realtime, and a Supabase-backed job queue or job table for extraction, indexing, scheduled work, and recoverable agent execution. Check actual host capacity and process limits before selecting extraction libraries and job batch sizes. Follow the accompanying self-hosting addendum for deployment assets and storage.

Job records need: workspace, execution principal, kind, payload reference, status, attempt count, next-attempt time, lease owner/expiry, idempotency key, timestamps, and safe error detail. Claim jobs atomically. Recover expired leases. Bound retries and expose terminal failures. Store outputs durably before finalizing success. Short jobs may run in a request; work exceeding request limits needs persisted checkpoints or a supported worker runtime. Never rely on an unawaited promise after an HTTP response.

For AI streaming, separate the persisted run lifecycle from the viewer's connection. Persist meaningful checkpoints/final output, recover interrupted attempts honestly, and deduplicate tool side effects. Recover from a worker restart using the persisted run and lease state.

Audit the current browser scheduler and SQL cron together. The existing code claims scheduled messages before sending, and SQL handles its own claims and attachment moves. Establish an authoritative transactional/idempotent delivery path so a failure does not lose content, an absent tab does not stop delivery, and two workers do not send duplicates. Recheck sender access at execution time.

Provide Docker, Compose, and reverse-proxy configuration: SPA deep links must load the app, static assets retain appropriate caching, and `/api/*` must reach the Node backend rather than `index.html`. Do not mark authenticated responses or signed downloads as publicly cacheable. Use request IDs and structured logs with redaction. Verify webhook signatures and scheduler authentication if those endpoints exist. Keep `vercel.json` only if an optional Vercel deployment remains supported and tested.

Document environment variables with public/server-only scope, purpose, and how they differ between local, staging, and production. Include Supabase URL and public client key, server credentials where actually needed, AI credentials/model settings, application URL, and worker secrets. Reuse existing variable names where reasonable. Update `.env.example` with placeholders only.

Use isolated data and credentials for staging. Configure authentication redirect URLs and authorized origins. Build with the repository's supported Node version and lockfile. Deploy/verify in an already authorized environment when available; do not unexpectedly migrate production or overwrite an existing production deployment. If server access is absent, produce deployable images/configuration and exact setup instructions, while identifying live deployment as unverified.

## 14. Search, notifications, and performance

Extend global search across messages, Drive resources, accessible document text, tasks/projects, agents, and CRM records. Provide type and scope filters, keyboard selection, useful snippets, and deep links. Prefer indexed database search for the first working version; semantic search enhances it when configured. Empty results must not reveal the existence of inaccessible records.

Unify notifications for mentions, thread replies, shares/access requests, task assignments, agent completion/failure, and approvals. Respect workspace and conversation preferences. Persist read state and link to the relevant object. Do not generate both browser and backend copies of the same event.

Paginate large collections, virtualize existing long message/file lists where appropriate, and subscribe only to necessary realtime streams. Use server-side aggregates for dashboard counts rather than downloading every task. Lazy-load substantial new route modules and heavy preview/parsing dependencies. Preserve existing optimizations after understanding them.

Measure representative loaded states with realistic test data. Resolve concrete slow queries and unnecessary refetches; avoid broad performance rewrites unrelated to the new flows.

## 15. Implementation sequence and checkpoints

Work in small, integrated slices. Keep `docs/IMPLEMENTATION_STATUS.md` current with decisions, migrations, completed journeys, verification, and exact blockers. Do not use this document as a substitute for implementation.

1. **Baseline:** inspect architecture/schema, run existing build/lint, document failures already present, identify reusable components, and establish the migration approach.
2. **Shell and tenancy:** unify navigation and contextual panels, add route/deep-link handling, strengthen affected tenant boundaries, and verify switching between two workspaces.
3. **Drive vertical slice:** upload independently, create folders, preview, grant/revoke access, attach the same file to a channel, and preserve legacy attachments.
4. **AI vertical slice:** one configured agent, persisted conversation/run, selected-document retrieval, valid citations, and a reviewed Save to Drive action.
5. **Collaboration integration:** mention an agent in a thread, publish an audience-safe reply, propose/approve a task, and recover the run after refresh.
6. **Agent dashboard and catalog:** seed distinct useful configurations on the shared engine, implement configuration/knowledge/activity panels, and show actual availability.
7. **CRM and automation connections:** implement the defined contact/company/deal workflows and selected automation templates using existing productivity entities.
8. **Hardening and deployment:** migration/backfill verification, permission and failure tests, responsive/accessibility checks, build/lint, environment documentation, and authorized self-hosted verification.

After each slice, verify the actual journey before expanding UI breadth. Continue into the next slice without waiting for routine approval. If context is running low, write a precise checkpoint so work can continue; never mark the remaining product as complete merely because the current session ended.

## 16. Acceptance criteria and evidence

The product is complete only when these journeys and boundaries are implemented and verified, or an actual external blocker is identified explicitly:

| Scenario | Required result |
|---|---|
| Existing behavior | Sign-in, workspace switching, channels, DMs, threads, tasks/projects, and existing attachments remain usable. |
| First-use workspace | A new workspace can invite a member, create a channel, upload a file, and discover agent setup through real empty states. |
| Connected main journey | Upload a PDF → share it with a channel → ask Knowledge Assistant → receive a valid source citation → approve saving a summary → approve creating an assigned task → see the same file/task in Drive and existing Tasks. |
| Cross-tenant attack | A member of workspace A cannot read, mutate, subscribe to, preview, retrieve, or export workspace B resources by changing an ID or calling the API directly. |
| Private resources | A nonparticipant cannot discover private-channel/DM content through Files, search, AI, notifications, metrics, or links. Admin status alone does not bypass this. |
| Revocation | Removing a grant or member blocks future access and queued actions, clears relevant UI state, and respects the documented signed-URL expiry behavior. |
| Shared AI response | A channel reply cannot include content from sources unavailable to its authorized audience. Private results remain private. |
| File lifecycle | Versions and message references survive rename/move appropriately; deleting one attachment does not break another reference; trash/restore and access changes behave predictably. |
| Legacy migration | Representative old channel, DM, forwarded, and link attachments remain accessible to the correct users without broadening access. Backfill reruns do not duplicate resources. |
| Failed upload/indexing | Interrupted uploads, unsupported extraction, provider errors, and retry exhaustion show accurate recoverable or terminal states. |
| AI persistence | Refresh/reconnect restores conversation and run state; cancellation works; a repeated request/approval does not duplicate side effects. |
| Prompt injection | Malicious document instructions cannot change tenant scope, reveal secrets, or invoke unauthorized tools. |
| Scheduling | Scheduled work executes with the browser closed; duplicate workers and partial failures do not duplicate or silently lose deliveries. |
| CRM | Create company/contact/deal, associate a file and task, move the deal stage, and recover the persisted activity after refresh. |
| Hosting | Directly loading a nested route works; API endpoints return the expected API response; no secret appears in built browser assets. |
| Responsive UI | Core desktop, tablet, and mobile journeys work with keyboard-accessible menus, dialogs, uploads, and drawers. |

Add focused automated tests for the risky behavior: RLS and resource permissions using genuinely different users/tenants, API authorization, same-tenant associations, idempotent actions, migration compatibility, and the connected browser journey. Use the existing test framework if present; otherwise add the smallest appropriate unit/integration and browser test setup. Tests that only mirror component implementation are insufficient.

Use a local or dedicated test Supabase project. Never run destructive fixtures against production. Test both clean provisioning and upgrade from a representative legacy fixture. Do not treat a service-role-only test as proof that RLS works. Include anonymous access, ordinary members, private-resource outsiders, and removed members.

Run `npm run build` and `npm run lint`, targeted tests, and a browser verification of actual interactions. Inspect console and network errors. Record precisely what passed, what failed, and what could not be exercised. Capture representative screenshots of Home, Chat/thread, Drive/preview, Agents/conversation, and CRM when the UI is working. Demo data may support isolated development previews but must never masquerade as production data.

## 17. Required handoff

Deliver the implemented repository changes, additive migrations, updated types, environment template, setup/deployment instructions, and concise architecture/permission notes. Include the migration/backfill procedure, job/worker deployment requirements, and recovery instructions for failed indexing or runs.

End with a concise report stating:

- What now works for an actual user.
- Which repository areas changed and why.
- Which build, permission, migration, and browser checks were executed and their results.
- Any real external configuration blocker, with the exact action needed.
- A URL if an authorized deployment was completed; otherwise the commands and configuration for deployment.

Do not claim features are complete when only their frontend exists. Do not claim deployment, live AI generation, or two-user realtime behavior was tested without evidence. Start by inspecting the repository and establishing the baseline, then implement the connected product.
