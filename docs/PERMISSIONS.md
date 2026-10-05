# Permissions

The workspace is the tenant boundary. Browser data operations use the signed-in Supabase token and RLS. API handlers verify that token and current membership before calling server-only functions. Service keys and provider keys belong only in server environment variables.

| Resource | Access rules |
| --- | --- |
| Drive | Owner plus explicit user, channel, project or workspace grants. Viewer/commenter/editor roles; inherited grants follow folder ancestry. Restricted folders stop inheritance. Workspace admins have no automatic private-file access. |
| File URLs | Short-lived signed Storage URLs issued after current access checks. Copying a URL does not create a grant. Already issued URLs remain bearer credentials until expiry. |
| Chat file references | Sending links does not silently widen file access. The composer requires consent when adding a channel grant; the RPC validates all references and commits the message and grants together. Request IDs prevent duplicate messages. |
| Documents | Save requires editor/owner access and the expected base revision. Concurrent changes produce a conflict, preserving the user's draft. |
| Knowledge | Search/read recheck source access and current membership. Results retain source version/revision information. |
| Agents | Private conversations persist by user and workspace. Channel invocations restrict source use to the destination audience; inaccessible history/citations are redacted on read. Tool execution rechecks access. |
| Agent writes | Task, document, message and CRM writes produce review cards. Approval is tied to the stored arguments hash and rechecks permissions before a transactional, idempotent execution. |
| CRM | Current workspace members can read records. Creator, assigned owner or workspace admin/owner can edit. Owners must be active members. Linked file/task/channel rows remain hidden if the viewer cannot access the target. |
| Internal functions | Job and privileged agent functions are service-role-only; authenticated RPCs derive identity from `auth.uid()`. |

Workspace switches and sign-out clear query/signed-URL caches. Workspace-bound providers remount, thread panels reset, and thread message content is no longer persisted in localStorage. Message drafts use user/channel/thread keys. Authorization is still enforced by the database, not by cache cleanup.

The local permission suite covers multiple identities/workspaces, revocation, private channels/files, ownership, grant changes, proposal retries and membership removal. Hosted Realtime revocation timing and real Storage signed-URL behavior still require deployment verification.
