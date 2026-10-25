# Permissions

The workspace is the tenant boundary. Browser data operations use the same-origin API and a server-issued session; PostgreSQL RLS remains the final data boundary. API handlers verify the session and current membership before privileged operations. Provider keys remain encrypted on the server and are never returned to browsers.

| Resource | Access rules |
| --- | --- |
| Drive | Owner plus explicit user, channel, project or workspace grants. Viewer/commenter/editor roles; inherited grants follow folder ancestry. Restricted folders stop inheritance. Workspace admins have no automatic private-file access. |
| File URLs | Short-lived signed Storage URLs issued after current access checks. Copying a URL does not create a grant. Already issued URLs remain bearer credentials until expiry. |
| Chat file references | Sending links does not silently widen file access. The composer requires consent when adding a channel grant; the RPC validates all references and commits the message and grants together. Request IDs prevent duplicate messages. |
| Documents | Save requires editor/owner access and the expected base revision. Concurrent changes produce a conflict, preserving the user's draft. |
| Knowledge | Search/read recheck source access and current membership. Results retain source version/revision information. |
| Agents | Private conversations persist by user and workspace. Channel invocations restrict source use to the destination audience; inaccessible history/citations are redacted on read. Tool execution rechecks access. |
| Agent writes | Task, document, message, calendar-event and CRM writes produce review cards. Approval is tied to the stored arguments hash and rechecks permissions before a transactional, idempotent execution. The same action proposed again after a restart returns the existing card. |
| Team chat | The coordinator can delegate one level deep, to at most 4 specialists per call and 8 per team run. Specialists run as the same requester with the same access; they cannot delegate, and delegation never adds permissions. Everything a specialist read becomes a source of the team run, so sharing the combined answer is checked against all of it. Cancelling the team run cancels its specialists. |
| Project managers | Chosen per workspace by owners/admins (Settings → Members). They approve task requests; when none are chosen, owners and admins approve. Leaving the workspace removes the designation. |
| Task requests | Scribe's `submit_tasks_for_approval` creates requests, never tasks. Requests are readable by their submitter and by the approvers only; nobody writes them directly. Approval (optionally with edits) creates the task as the approving manager after rechecking assignee membership and project edit rights; repeats are no-ops. Requests made from a direct-message session are visible to the approvers. |
| AI sessions | Only participants of a direct conversation can invite Scribe or finish a session, and the active state is visible to all participants. The notes run reads exactly the messages sent while the session was active and has no other read tools; its notes are posted to the conversation without a review card because the participants invited it. |
| Push notifications | Subscriptions belong to the signed-in person; a browser's endpoint moves to whoever registers it last and is removed on sign-out. Only task assignment and approval notifications are pushed. Endpoints are limited to the browsers' push services. |
| Personal notes | Notes kept with the personal coach are readable and deletable only by their owner (not by workspace admins) and are never used for retrieval or by other agents. |
| Workspace metrics | Aggregates count only records the requester can see; counted tasks and conversations are recorded as run sources. Deal values are summed per currency. |
| Calendar | Agents read only events the requester organizes or attends. Proposed events are visible to the whole workspace, so they are blocked when the run used sources some members cannot open. |
| Site fetches | The SEO specialist's page reads are run by the model provider and restricted to the domain an admin configured; this server makes no outbound requests on the model's behalf. |
| Connectors | Connection state is written only by the server; members can read it. Nothing is shown as connected without a real integration. |
| CRM | Current workspace members can read records. Creator, assigned owner or workspace admin/owner can edit. Owners must be active members. Linked file/task/channel rows remain hidden if the viewer cannot access the target. |
| Internal functions | Job and privileged agent functions are service-role-only; authenticated RPCs derive identity from `auth.uid()`. |

Workspace switches and sign-out clear query/signed-URL caches. Workspace-bound providers remount, thread panels reset, and thread message content is no longer persisted in localStorage. Message drafts use user/channel/thread keys. Authorization is still enforced by the database, not by cache cleanup.

The local permission suite covers multiple identities/workspaces, revocation, private channels/files, ownership, grant changes, proposal retries and membership removal. Production SSE revocation timing, expiring signed URLs and TURN relay behavior also require deployment acceptance.
