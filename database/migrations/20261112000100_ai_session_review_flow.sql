-- Keep conversation AI sessions open for a review/clarification turn before
-- final notes create task approval requests. Sessions are available in direct
-- conversations and in the canonical #general channel.

ALTER TABLE public.conversation_ai_sessions
  ADD COLUMN IF NOT EXISTS review_run_id uuid
    REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_requested_by uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_status text,
  ADD COLUMN IF NOT EXISTS review_attempt integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notes_requested_by uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notes_status text,
  ADD COLUMN IF NOT EXISTS notes_attempt integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS abandoned_by uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS abandoned_at timestamptz;

-- Preserve the real state of final-note runs created before this lifecycle was
-- introduced, so a failed historical run is retryable instead of looking
-- permanently queued.
UPDATE public.conversation_ai_sessions session
SET notes_status = run.status,
    notes_attempt = greatest(session.notes_attempt, 1),
    notes_requested_by = coalesce(session.notes_requested_by, run.requested_by)
FROM public.agent_runs run
WHERE session.notes_run_id = run.id
  AND (session.notes_status IS NULL OR session.notes_attempt = 0);

UPDATE public.conversation_ai_sessions session
SET review_requested_by = coalesce(session.review_requested_by, run.requested_by)
FROM public.agent_runs run
WHERE session.review_run_id = run.id
  AND session.review_requested_by IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.conversation_ai_sessions'::regclass
      AND conname = 'conversation_ai_sessions_review_request_check'
  ) THEN
    ALTER TABLE public.conversation_ai_sessions
      ADD CONSTRAINT conversation_ai_sessions_review_request_check
      CHECK (
        review_attempt >= 0
        AND (review_run_id IS NULL OR review_requested_at IS NOT NULL)
        AND (
          review_status IS NULL
          OR review_status IN ('reserving', 'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.conversation_ai_sessions'::regclass
      AND conname = 'conversation_ai_sessions_notes_check'
  ) THEN
    ALTER TABLE public.conversation_ai_sessions
      ADD CONSTRAINT conversation_ai_sessions_notes_check
      CHECK (
        notes_attempt >= 0
        AND (
          notes_status IS NULL
          OR notes_status IN ('reserving', 'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversation_ai_sessions_review_run
  ON public.conversation_ai_sessions (review_run_id)
  WHERE review_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_ai_sessions_notes_run
  ON public.conversation_ai_sessions (notes_run_id)
  WHERE notes_run_id IS NOT NULL;

-- Older clients could choose any visible agent when starting a notes session.
-- Canonicalize every safe active/retryable row before the replacement RPC is
-- installed. A noncanonical run already in flight is stopped and its session
-- abandoned instead: changing the agent underneath a running worker would let
-- that worker cross the new identity boundary.
DO $$
DECLARE
  queued_run record;
BEGIN
  UPDATE public.agent_runs run
  SET cancel_requested_at = coalesce(run.cancel_requested_at, now())
  FROM public.conversation_ai_sessions session
  WHERE run.id IN (session.review_run_id, session.notes_run_id)
    AND run.status = 'running'
    AND session.agent_id IS DISTINCT FROM (
      SELECT canonical.id
      FROM public.workspace_agents canonical
      WHERE canonical.workspace_id = session.workspace_id
        AND canonical.template_key = 'cerebras_writer'
        AND canonical.is_builtin
        AND canonical.archived_at IS NULL
      ORDER BY canonical.created_at, canonical.id
      LIMIT 1
    )
    AND (
      session.status = 'active'
      OR session.notes_status IN ('reserving', 'queued', 'running', 'failed', 'cancelled', 'interrupted')
    );

  FOR queued_run IN
    SELECT DISTINCT run.id
    FROM public.agent_runs run
    JOIN public.conversation_ai_sessions session
      ON run.id IN (session.review_run_id, session.notes_run_id)
    WHERE run.status = 'queued'
      AND session.agent_id IS DISTINCT FROM (
        SELECT canonical.id
        FROM public.workspace_agents canonical
        WHERE canonical.workspace_id = session.workspace_id
          AND canonical.template_key = 'cerebras_writer'
          AND canonical.is_builtin
          AND canonical.archived_at IS NULL
        ORDER BY canonical.created_at, canonical.id
        LIMIT 1
      )
      AND (
        session.status = 'active'
        OR session.notes_status IN ('reserving', 'queued', 'running', 'failed', 'cancelled', 'interrupted')
      )
    ORDER BY run.id
  LOOP
    PERFORM public.agent_finish_run(
      queued_run.id, NULL, 'cancelled', NULL, NULL, 'cancelled',
      'Outdated notes agent session was cancelled during upgrade.'
    );
  END LOOP;
END $$;

UPDATE public.conversation_ai_sessions session
SET status = 'finished',
    ended_by = coalesce(session.ended_by, session.started_by),
    ended_at = coalesce(session.ended_at, now()),
    abandoned_by = coalesce(session.abandoned_by, session.started_by),
    abandoned_at = coalesce(session.abandoned_at, now()),
    review_status = CASE
      WHEN session.review_status IN ('reserving', 'queued', 'running') THEN 'cancelled'
      ELSE session.review_status
    END,
    notes_status = NULL
WHERE session.abandoned_at IS NULL
  AND session.agent_id IS DISTINCT FROM (
    SELECT canonical.id
    FROM public.workspace_agents canonical
    WHERE canonical.workspace_id = session.workspace_id
      AND canonical.template_key = 'cerebras_writer'
      AND canonical.is_builtin
      AND canonical.archived_at IS NULL
    ORDER BY canonical.created_at, canonical.id
    LIMIT 1
  )
  AND EXISTS (
    SELECT 1
    FROM public.agent_runs run
    WHERE run.id IN (session.review_run_id, session.notes_run_id)
      AND (
        run.cancel_requested_at IS NOT NULL
        OR run.error_message = 'Outdated notes agent session was cancelled during upgrade.'
      )
  );

-- A workspace without the built-in note taker cannot safely keep a legacy
-- session alive. Hide it as explicitly abandoned until roster repair creates
-- the canonical agent and the user starts a fresh session.
UPDATE public.conversation_ai_sessions session
SET status = 'finished',
    ended_by = coalesce(session.ended_by, session.started_by),
    ended_at = coalesce(session.ended_at, now()),
    abandoned_by = coalesce(session.abandoned_by, session.started_by),
    abandoned_at = coalesce(session.abandoned_at, now()),
    review_status = CASE
      WHEN session.review_status IN ('reserving', 'queued', 'running') THEN 'cancelled'
      ELSE session.review_status
    END,
    notes_status = NULL
WHERE session.abandoned_at IS NULL
  AND (
    session.status = 'active'
    OR session.notes_status IN ('reserving', 'queued', 'running', 'failed', 'cancelled', 'interrupted')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.workspace_agents canonical
    WHERE canonical.workspace_id = session.workspace_id
      AND canonical.template_key = 'cerebras_writer'
      AND canonical.is_builtin
      AND canonical.archived_at IS NULL
  );

UPDATE public.conversation_ai_sessions session
SET agent_id = (
      SELECT canonical.id
      FROM public.workspace_agents canonical
      WHERE canonical.workspace_id = session.workspace_id
        AND canonical.template_key = 'cerebras_writer'
        AND canonical.is_builtin
        AND canonical.archived_at IS NULL
      ORDER BY canonical.created_at, canonical.id
      LIMIT 1
    ),
    review_run_id = CASE WHEN session.status = 'active' THEN NULL ELSE session.review_run_id END,
    review_requested_at = CASE WHEN session.status = 'active' THEN NULL ELSE session.review_requested_at END,
    review_requested_by = CASE WHEN session.status = 'active' THEN NULL ELSE session.review_requested_by END,
    review_status = CASE WHEN session.status = 'active' THEN NULL ELSE session.review_status END,
    review_attempt = CASE WHEN session.status = 'active' THEN 0 ELSE session.review_attempt END
WHERE session.abandoned_at IS NULL
  AND (
    session.status = 'active'
    OR session.notes_status IN ('reserving', 'failed', 'cancelled', 'interrupted')
  )
  AND session.agent_id IS DISTINCT FROM (
    SELECT canonical.id
    FROM public.workspace_agents canonical
    WHERE canonical.workspace_id = session.workspace_id
      AND canonical.template_key = 'cerebras_writer'
      AND canonical.is_builtin
      AND canonical.archived_at IS NULL
    ORDER BY canonical.created_at, canonical.id
    LIMIT 1
  );

-- Sessions remain deliberately narrow: DMs keep their existing behaviour and
-- the workspace-wide notes workflow is available only in canonical #general,
-- not in every channel merely because it is public.
CREATE OR REPLACE FUNCTION public.ai_session_start(
  p_actor uuid,
  p_channel_id uuid,
  p_agent_id uuid
) RETURNS public.conversation_ai_sessions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  session public.conversation_ai_sessions%ROWTYPE;
  target_workspace_id uuid;
  agent public.workspace_agents%ROWTYPE;
BEGIN
  SELECT channel.workspace_id INTO target_workspace_id
  FROM public.channels channel
  WHERE channel.id = p_channel_id
    AND channel.archived_at IS NULL
    AND (
      channel.slug = 'general'
      OR EXISTS (
        SELECT 1
        FROM public.direct_conversations conversation
        WHERE conversation.channel_id = channel.id
      )
    );
  IF target_workspace_id IS NULL
     OR NOT public.user_is_channel_member(p_channel_id, p_actor) THEN
    RAISE EXCEPTION 'Conversation not found' USING ERRCODE = '42501';
  END IF;

  -- Keep p_agent_id in the signature for deployed clients, but never trust it
  -- to choose the session identity. AI notes always use the workspace's active
  -- built-in note taker.
  SELECT * INTO agent
  FROM public.workspace_agents
  WHERE workspace_id = target_workspace_id
    AND template_key = 'cerebras_writer'
    AND is_builtin
    AND archived_at IS NULL
  ORDER BY created_at, id
  LIMIT 1;
  IF agent.id IS NULL
     OR agent.archived_at IS NOT NULL
     OR NOT public.agent_visible_to(agent.id, p_actor) THEN
    RAISE EXCEPTION 'Agent not found' USING ERRCODE = '42501';
  END IF;
  IF agent.status <> 'active' THEN
    RAISE EXCEPTION 'This agent is disabled' USING ERRCODE = '55000';
  END IF;
  IF NOT (public.ai_settings_for(target_workspace_id)).enabled THEN
    RAISE EXCEPTION 'AI is turned off for this workspace' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE channel_id = p_channel_id
    AND status = 'active';
  IF session.id IS NOT NULL THEN
    IF session.agent_id IS DISTINCT FROM agent.id THEN
      RAISE EXCEPTION 'This notes session uses an outdated agent. Cancel it and start a new session.'
        USING ERRCODE = '55000';
    END IF;
    RETURN session;
  END IF;

  INSERT INTO public.conversation_ai_sessions (
    workspace_id, channel_id, agent_id, started_by
  ) VALUES (
    target_workspace_id, p_channel_id, agent.id, p_actor
  )
  ON CONFLICT (channel_id) WHERE status = 'active' DO NOTHING
  RETURNING * INTO session;
  IF session.id IS NULL THEN
    SELECT * INTO session
    FROM public.conversation_ai_sessions
    WHERE channel_id = p_channel_id
      AND status = 'active';
  END IF;
  IF session.agent_id IS DISTINCT FROM agent.id THEN
    RAISE EXCEPTION 'This notes session uses an outdated agent. Cancel it and start a new session.'
      USING ERRCODE = '55000';
  END IF;
  RETURN session;
END $$;

-- Include immutable author ids so equal display names cannot make task
-- ownership ambiguous to the model.
DROP FUNCTION IF EXISTS public.ai_session_transcript_for(uuid, uuid);
CREATE FUNCTION public.ai_session_transcript_for(
  p_actor uuid,
  p_session_id uuid
) RETURNS TABLE(
  id uuid,
  author_id uuid,
  author_name text,
  is_agent boolean,
  content text,
  created_at timestamptz,
  parent_id uuid,
  truncated boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  session public.conversation_ai_sessions%ROWTYPE;
BEGIN
  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE conversation_ai_sessions.id = p_session_id;
  IF session.id IS NULL
     OR NOT public.user_is_channel_member(session.channel_id, p_actor) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT * FROM (
    SELECT message.id,
      coalesce(message.agent_id, message.user_id),
      coalesce(agent.name || ' (agent)', profile.display_name, profile.username, 'Someone')::text,
      message.agent_id IS NOT NULL,
      message.content,
      message.created_at,
      message.parent_id,
      count(*) OVER () > 500
    FROM public.messages message
    LEFT JOIN public.profiles profile ON profile.id = message.user_id
    LEFT JOIN public.workspace_agents agent ON agent.id = message.agent_id
    WHERE message.channel_id = session.channel_id
      AND message.deleted_at IS NULL
      AND message.created_at >= session.started_at
      AND message.created_at <= coalesce(session.ended_at, now())
    ORDER BY message.created_at DESC
    LIMIT 500
  ) recent
  ORDER BY recent.created_at;
END $$;

-- Every DM participant can control a DM session. In #general everyone may
-- follow and answer the notes agent, but only the starter or a channel/workspace
-- administrator can review or finish the shared session.
CREATE OR REPLACE FUNCTION public.ai_session_actor_can_control(
  p_session_id uuid,
  p_actor uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.conversation_ai_sessions session
    JOIN public.channels channel ON channel.id = session.channel_id
    WHERE session.id = p_session_id
      AND session.abandoned_at IS NULL
      AND public.user_is_channel_member(session.channel_id, p_actor)
      AND (
        EXISTS (
          SELECT 1
          FROM public.direct_conversations conversation
          WHERE conversation.channel_id = session.channel_id
        )
        OR session.started_by = p_actor
        OR channel.created_by = p_actor
        OR public.user_is_workspace_admin(session.workspace_id, p_actor)
      )
  );
$$;

-- Reserve one idempotent review for an active session. The session deliberately
-- remains active, so participant answers sent after the review are part of the
-- final transcript.
CREATE OR REPLACE FUNCTION public.ai_session_request_review(
  p_actor uuid,
  p_session_id uuid
) RETURNS public.conversation_ai_sessions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  session public.conversation_ai_sessions%ROWTYPE;
BEGIN
  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF session.id IS NULL
     OR NOT public.ai_session_actor_can_control(session.id, p_actor) THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = '42501';
  END IF;
  IF session.abandoned_at IS NOT NULL THEN
    RAISE EXCEPTION 'This notes session was cancelled. Start a new session.'
      USING ERRCODE = '55000';
  END IF;
  IF session.status <> 'active' THEN
    RAISE EXCEPTION 'This session is already finished' USING ERRCODE = '55000';
  END IF;

  -- An existing successful/in-flight review is idempotent. A terminal failed
  -- review may be retried with a new attempt/idempotency key.
  IF session.review_status IN ('reserving', 'queued', 'running', 'completed') THEN
    RETURN session;
  END IF;

  UPDATE public.conversation_ai_sessions
  SET review_requested_at = now(),
      review_requested_by = p_actor,
      review_run_id = NULL,
      review_status = 'reserving',
      review_attempt = review_attempt + 1
  WHERE id = session.id
  RETURNING * INTO session;
  RETURN session;
END $$;

-- Server-only attachment. Verify the run belongs to this exact session before
-- exposing it to participants through the session row.
CREATE OR REPLACE FUNCTION public.ai_session_attach_review_run(
  p_session_id uuid,
  p_run_id uuid
) RETURNS public.conversation_ai_sessions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  session public.conversation_ai_sessions%ROWTYPE;
  run public.agent_runs%ROWTYPE;
BEGIN
  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE id = p_session_id
  FOR UPDATE;
  SELECT * INTO run
  FROM public.agent_runs
  WHERE id = p_run_id;

  IF session.id IS NULL OR session.status <> 'active' THEN
    RAISE EXCEPTION 'Active session not found' USING ERRCODE = '55000';
  END IF;
  IF run.id IS NULL
     OR run.workspace_id IS DISTINCT FROM session.workspace_id
     OR run.agent_id IS DISTINCT FROM session.agent_id
     OR run.requested_by IS DISTINCT FROM session.review_requested_by
     OR NOT public.user_is_channel_member(session.channel_id, run.requested_by)
     OR run.trigger <> 'session_notes'
     OR run.scope ->> 'session_id' IS DISTINCT FROM session.id::text
     OR run.scope ->> 'channel_id' IS DISTINCT FROM session.channel_id::text
     OR run.scope ->> 'session_phase' IS DISTINCT FROM 'review'
     OR run.scope ->> 'session_attempt' IS DISTINCT FROM session.review_attempt::text
     OR run.status <> 'queued' THEN
    RAISE EXCEPTION 'Review run does not belong to this session'
      USING ERRCODE = '42501';
  END IF;
  IF run.destination ->> 'type' IS DISTINCT FROM 'channel'
     OR run.destination ->> 'channel_id' IS DISTINCT FROM session.channel_id::text THEN
    RAISE EXCEPTION 'Review run has the wrong destination'
      USING ERRCODE = '42501';
  END IF;
  IF session.review_run_id IS NOT NULL
     AND session.review_run_id IS DISTINCT FROM run.id THEN
    RAISE EXCEPTION 'A review is already attached to this session'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.conversation_ai_sessions
  SET review_requested_at = coalesce(review_requested_at, now()),
      review_run_id = run.id,
      review_status = run.status
  WHERE id = session.id
  RETURNING * INTO session;

  -- The attachment and durable enqueue are one transaction. A process crash
  -- cannot leave participants looking at a queued review that has no job.
  PERFORM public.enqueue_job(
    'agent.run', session.workspace_id, run.requested_by,
    jsonb_build_object('run_id', run.id), 'run:' || run.id::text, now(), 3
  );
  RETURN session;
END $$;

-- Validate finalization before creating a run. The actual finish, run
-- attachment and durable job enqueue happen atomically below.
CREATE OR REPLACE FUNCTION public.ai_session_prepare_finish(
  p_actor uuid,
  p_session_id uuid
) RETURNS public.conversation_ai_sessions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  session public.conversation_ai_sessions%ROWTYPE;
  human_message_count integer;
BEGIN
  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE id = p_session_id;
  IF session.id IS NULL
     OR NOT public.ai_session_actor_can_control(session.id, p_actor) THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = '42501';
  END IF;
  IF session.abandoned_at IS NOT NULL THEN
    RAISE EXCEPTION 'This notes session was cancelled. Start a new session.'
      USING ERRCODE = '55000';
  END IF;
  IF session.status <> 'active' THEN
    RETURN session;
  END IF;

  SELECT count(*)::integer INTO human_message_count
  FROM public.messages message
  WHERE message.channel_id = session.channel_id
    AND message.deleted_at IS NULL
    AND message.agent_id IS NULL
    AND message.created_at >= session.started_at
    AND message.created_at <= now();
  IF human_message_count > 0
     AND (session.review_run_id IS NULL OR session.review_status <> 'completed') THEN
    IF session.review_status IN ('reserving', 'queued', 'running') THEN
      RAISE EXCEPTION 'Wait for the AI review before finishing this session'
        USING ERRCODE = '55000';
    ELSIF session.review_status IN ('failed', 'cancelled', 'interrupted') THEN
      RAISE EXCEPTION 'Retry the AI review before finishing this session'
        USING ERRCODE = '55000';
    ELSE
      RAISE EXCEPTION 'Review this session before finishing it'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  session.message_count := human_message_count;
  RETURN session;
END $$;

-- Reserve an idempotent final-notes attempt. A failed terminal run can reserve
-- a fresh attempt over the already frozen transcript; an in-flight attempt is
-- returned unchanged so a retried HTTP request can continue it safely.
CREATE OR REPLACE FUNCTION public.ai_session_request_finish(
  p_actor uuid,
  p_session_id uuid
) RETURNS public.conversation_ai_sessions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  session public.conversation_ai_sessions%ROWTYPE;
  human_message_count integer;
BEGIN
  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE id = p_session_id
  FOR UPDATE;
  IF session.id IS NULL
     OR NOT public.user_is_channel_member(session.channel_id, p_actor)
     OR NOT (
       EXISTS (
         SELECT 1 FROM public.direct_conversations conversation
         WHERE conversation.channel_id = session.channel_id
       )
       OR session.started_by = p_actor
       OR EXISTS (
         SELECT 1 FROM public.channels channel
         WHERE channel.id = session.channel_id
           AND channel.created_by = p_actor
       )
       OR public.user_is_workspace_admin(session.workspace_id, p_actor)
     ) THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = '42501';
  END IF;
  IF session.abandoned_at IS NOT NULL THEN
    RAISE EXCEPTION 'This notes session was cancelled. Start a new session.'
      USING ERRCODE = '55000';
  END IF;

  IF session.status = 'active' THEN
    SELECT count(*)::integer INTO human_message_count
    FROM public.messages message
    WHERE message.channel_id = session.channel_id
      AND message.deleted_at IS NULL
      AND message.agent_id IS NULL
      AND message.created_at >= session.started_at
      AND message.created_at <= now();

    IF human_message_count > 0
       AND (session.review_run_id IS NULL OR session.review_status <> 'completed') THEN
      IF session.review_status IN ('reserving', 'queued', 'running') THEN
        RAISE EXCEPTION 'Wait for the AI review before finishing this session'
          USING ERRCODE = '55000';
      ELSIF session.review_status IN ('failed', 'cancelled', 'interrupted') THEN
        RAISE EXCEPTION 'Retry the AI review before finishing this session'
          USING ERRCODE = '55000';
      ELSE
        RAISE EXCEPTION 'Review this session before finishing it'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    session.message_count := human_message_count;
  ELSE
    human_message_count := coalesce(session.message_count, 0);
  END IF;

  IF human_message_count = 0
     OR session.notes_status IN ('reserving', 'queued', 'running', 'completed') THEN
    RETURN session;
  END IF;

  UPDATE public.conversation_ai_sessions
  SET notes_run_id = NULL,
      notes_requested_by = p_actor,
      notes_status = 'reserving',
      notes_attempt = notes_attempt + 1,
      message_count = human_message_count
  WHERE id = session.id
  RETURNING * INTO session;
  RETURN session;
END $$;

-- Attach the exact final run, freeze the transcript, and create its worker job
-- in one transaction. Failed final runs can later reserve a fresh attempt.
CREATE OR REPLACE FUNCTION public.ai_session_finish_with_run(
  p_actor uuid,
  p_session_id uuid,
  p_run_id uuid
) RETURNS public.conversation_ai_sessions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  session public.conversation_ai_sessions%ROWTYPE;
  run public.agent_runs%ROWTYPE;
  human_message_count integer;
BEGIN
  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE id = p_session_id
  FOR UPDATE;
  IF session.id IS NULL
     OR NOT public.ai_session_actor_can_control(session.id, p_actor) THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = '42501';
  END IF;
  IF session.abandoned_at IS NOT NULL THEN
    RAISE EXCEPTION 'This notes session was cancelled. Start a new session.'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO run
  FROM public.agent_runs
  WHERE id = p_run_id;
  IF run.id IS NULL
     OR run.workspace_id IS DISTINCT FROM session.workspace_id
     OR run.agent_id IS DISTINCT FROM session.agent_id
     OR run.requested_by IS DISTINCT FROM session.notes_requested_by
     OR NOT public.user_is_channel_member(session.channel_id, run.requested_by)
     OR run.trigger <> 'session_notes'
     OR run.scope ->> 'session_id' IS DISTINCT FROM session.id::text
     OR run.scope ->> 'channel_id' IS DISTINCT FROM session.channel_id::text
     OR run.scope ->> 'session_phase' IS DISTINCT FROM 'final'
     OR run.scope ->> 'session_attempt' IS DISTINCT FROM session.notes_attempt::text
     OR run.destination ->> 'type' IS DISTINCT FROM 'channel'
     OR run.destination ->> 'channel_id' IS DISTINCT FROM session.channel_id::text THEN
    RAISE EXCEPTION 'Final notes run does not belong to this session'
      USING ERRCODE = '42501';
  END IF;

  -- Idempotent continuation after a response was lost. The job key guarantees
  -- that this does not enqueue the same run twice.
  IF session.notes_run_id = run.id
     AND session.notes_status IN ('queued', 'running', 'completed') THEN
    IF run.status = 'queued' THEN
      PERFORM public.enqueue_job(
        'agent.run', session.workspace_id, run.requested_by,
        jsonb_build_object('run_id', run.id), 'run:' || run.id::text, now(), 3
      );
    END IF;
    RETURN session;
  END IF;

  IF run.status <> 'queued' THEN
    RAISE EXCEPTION 'Final notes run is not queueable'
      USING ERRCODE = '55000';
  END IF;
  IF session.notes_status <> 'reserving' OR session.notes_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'A different final-notes attempt is already attached'
      USING ERRCODE = '55000';
  END IF;

  IF session.status = 'active' THEN
    SELECT count(*)::integer INTO human_message_count
    FROM public.messages message
    WHERE message.channel_id = session.channel_id
      AND message.deleted_at IS NULL
      AND message.agent_id IS NULL
      AND message.created_at >= session.started_at
      AND message.created_at <= now();
    IF human_message_count > 0
       AND (session.review_run_id IS NULL OR session.review_status <> 'completed') THEN
      RAISE EXCEPTION 'The AI review must complete before final notes'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    human_message_count := coalesce(session.message_count, 0);
  END IF;

  UPDATE public.conversation_ai_sessions
  SET status = 'finished',
      ended_by = coalesce(ended_by, p_actor),
      ended_at = coalesce(ended_at, now()),
      message_count = human_message_count,
      notes_run_id = run.id,
      notes_status = run.status
  WHERE id = session.id
  RETURNING * INTO session;

  PERFORM public.enqueue_job(
    'agent.run', session.workspace_id, run.requested_by,
    jsonb_build_object('run_id', run.id), 'run:' || run.id::text, now(), 3
  );
  RETURN session;
END $$;

-- Create, bind and enqueue a reserved session run behind the session row lock.
-- This is the serialization point for simultaneous clicks by different
-- participants: the first reservation's actor and attempt remain authoritative,
-- and every caller observes the same attached run.
CREATE OR REPLACE FUNCTION public.ai_session_start_run(
  p_actor uuid,
  p_session_id uuid,
  p_phase text,
  p_message text,
  p_estimated_tokens bigint
) RETURNS public.conversation_ai_sessions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  session public.conversation_ai_sessions%ROWTYPE;
  run_actor uuid;
  attempt integer;
  started jsonb;
  run_id uuid;
BEGIN
  IF p_phase NOT IN ('review', 'final') THEN
    RAISE EXCEPTION 'Unknown session phase' USING ERRCODE = '22023';
  END IF;
  IF p_estimated_tokens IS NULL OR p_estimated_tokens <= 0 THEN
    RAISE EXCEPTION 'Estimated tokens must be positive' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE id = p_session_id
  FOR UPDATE;
  IF session.id IS NULL
     OR NOT public.ai_session_actor_can_control(session.id, p_actor) THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = '42501';
  END IF;
  IF session.abandoned_at IS NOT NULL THEN
    RAISE EXCEPTION 'This notes session was cancelled. Start a new session.'
      USING ERRCODE = '55000';
  END IF;

  IF p_phase = 'review' THEN
    IF session.status <> 'active' THEN
      RAISE EXCEPTION 'This session is already finished' USING ERRCODE = '55000';
    END IF;
    IF session.review_run_id IS NOT NULL
       AND session.review_status IN ('queued', 'running', 'completed') THEN
      RETURN session;
    END IF;
    IF session.review_status <> 'reserving'
       OR session.review_run_id IS NOT NULL THEN
      RAISE EXCEPTION 'Review this session before starting its review run'
        USING ERRCODE = '55000';
    END IF;
    run_actor := session.review_requested_by;
    attempt := session.review_attempt;
  ELSE
    IF session.notes_run_id IS NOT NULL
       AND session.notes_status IN ('queued', 'running', 'completed') THEN
      RETURN session;
    END IF;
    IF session.notes_status <> 'reserving'
       OR session.notes_run_id IS NOT NULL THEN
      RAISE EXCEPTION 'Finish this session before starting its notes run'
        USING ERRCODE = '55000';
    END IF;
    run_actor := session.notes_requested_by;
    attempt := session.notes_attempt;
  END IF;

  IF run_actor IS NULL
     OR NOT public.user_is_channel_member(session.channel_id, run_actor) THEN
    RAISE EXCEPTION 'The participant who requested this run is no longer available'
      USING ERRCODE = '55000';
  END IF;

  started := public.agent_start_run(
    run_actor,
    session.workspace_id,
    session.agent_id,
    NULL,
    p_message,
    jsonb_build_object(
      'channel_id', session.channel_id,
      'session_id', session.id,
      'session_phase', p_phase,
      'session_attempt', attempt
    ),
    'session_notes',
    jsonb_build_object(
      'type', 'channel',
      'channel_id', session.channel_id,
      'session_id', session.id,
      'phase', p_phase
    ),
    jsonb_build_object(
      'type', 'channel',
      'channel_id', session.channel_id,
      'parent_id', NULL
    ),
    'session:' || session.id::text || ':' || p_phase || ':' || attempt::text,
    p_estimated_tokens
  );
  run_id := nullif(started ->> 'run_id', '')::uuid;
  IF run_id IS NULL THEN
    RAISE EXCEPTION 'The session run could not be created' USING ERRCODE = '55000';
  END IF;

  IF p_phase = 'review' THEN
    RETURN public.ai_session_attach_review_run(session.id, run_id);
  END IF;
  RETURN public.ai_session_finish_with_run(run_actor, session.id, run_id);
END $$;

-- If run creation fails before a run can be attached, release only the exact
-- reservation that failed. Another participant may have attached it already.
CREATE OR REPLACE FUNCTION public.ai_session_fail_review_reservation(
  p_session_id uuid,
  p_attempt integer
) RETURNS public.conversation_ai_sessions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  session public.conversation_ai_sessions%ROWTYPE;
  run public.agent_runs%ROWTYPE;
BEGIN
  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE id = p_session_id;
  IF session.id IS NULL THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO run
  FROM public.agent_runs candidate
  WHERE candidate.workspace_id = session.workspace_id
    AND candidate.agent_id = session.agent_id
    AND candidate.trigger = 'session_notes'
    AND candidate.scope ->> 'session_id' = session.id::text
    AND candidate.scope ->> 'channel_id' = session.channel_id::text
    AND candidate.scope ->> 'session_phase' = 'review'
    AND candidate.scope ->> 'session_attempt' = p_attempt::text
    AND candidate.destination ->> 'type' = 'channel'
    AND candidate.destination ->> 'channel_id' = session.channel_id::text
  ORDER BY candidate.created_at DESC
  LIMIT 1
  FOR UPDATE;

  -- agent_finish_run and its status trigger take run -> session. Match that
  -- order here so cleanup cannot deadlock a worker finishing the same run.
  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE id = p_session_id
  FOR UPDATE;
  IF session.id IS NULL THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = '42501';
  END IF;

  IF run.id IS NOT NULL
     AND session.review_run_id = run.id
     AND session.review_status IN ('queued', 'running', 'completed') THEN
    RETURN session;
  END IF;
  IF run.id IS NOT NULL AND run.status = 'queued' THEN
    PERFORM public.agent_finish_run(
      run.id, NULL, 'failed', NULL, NULL,
      'setup_failed', 'The session review could not be started.'
    );
  ELSIF run.id IS NOT NULL
        AND run.status NOT IN ('failed', 'cancelled', 'interrupted') THEN
    RETURN session;
  END IF;

  UPDATE public.conversation_ai_sessions
  SET review_status = 'failed'
  WHERE id = p_session_id
    AND status = 'active'
    AND review_attempt = p_attempt
    AND review_run_id IS NULL
    AND review_status = 'reserving'
  RETURNING * INTO session;

  IF session.id IS NULL THEN
    SELECT * INTO session
    FROM public.conversation_ai_sessions
    WHERE id = p_session_id;
  END IF;
  RETURN session;
END $$;

-- Terminalize a review run that could not be durably attached/enqueued. The
-- run is bound to the exact session attempt, so cleanup cannot cancel a newer
-- participant's retry. This is server-only because it bypasses auth.uid().
CREATE OR REPLACE FUNCTION public.ai_session_fail_review_attempt(
  p_session_id uuid,
  p_attempt integer,
  p_run_id uuid
) RETURNS public.conversation_ai_sessions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  session public.conversation_ai_sessions%ROWTYPE;
  run public.agent_runs%ROWTYPE;
BEGIN
  SELECT * INTO run
  FROM public.agent_runs
  WHERE id = p_run_id
  FOR UPDATE;
  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF session.id IS NULL OR run.id IS NULL
     OR run.workspace_id IS DISTINCT FROM session.workspace_id
     OR run.agent_id IS DISTINCT FROM session.agent_id
     OR run.trigger <> 'session_notes'
     OR run.scope ->> 'session_id' IS DISTINCT FROM session.id::text
     OR run.scope ->> 'channel_id' IS DISTINCT FROM session.channel_id::text
     OR run.scope ->> 'session_phase' IS DISTINCT FROM 'review'
     OR run.scope ->> 'session_attempt' IS DISTINCT FROM p_attempt::text THEN
    RAISE EXCEPTION 'Review run does not belong to this session attempt'
      USING ERRCODE = '42501';
  END IF;

  IF session.review_run_id = run.id
     AND session.review_status IN ('queued', 'running', 'completed') THEN
    RETURN session;
  END IF;

  IF run.status = 'queued' THEN
    PERFORM public.agent_finish_run(
      run.id, NULL, 'failed', NULL, NULL,
      'queue_failed', 'The session review could not be queued.'
    );
  END IF;

  UPDATE public.conversation_ai_sessions
  SET review_status = 'failed'
  WHERE id = session.id
    AND status = 'active'
    AND review_attempt = p_attempt
    AND review_status IN ('reserving', 'queued')
    AND (review_run_id IS NULL OR review_run_id = run.id)
  RETURNING * INTO session;

  IF session.id IS NULL THEN
    SELECT * INTO session
    FROM public.conversation_ai_sessions
    WHERE id = p_session_id;
  END IF;
  RETURN session;
END $$;

-- Release an exact final-notes reservation after run creation/attachment fails.
-- If the caller lost the run id (for example another participant owns the
-- idempotent queued run), locate it only by the exact session attempt.
CREATE OR REPLACE FUNCTION public.ai_session_fail_notes_attempt(
  p_session_id uuid,
  p_attempt integer,
  p_run_id uuid
) RETURNS public.conversation_ai_sessions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  session public.conversation_ai_sessions%ROWTYPE;
  run public.agent_runs%ROWTYPE;
  may_fail_reservation boolean := false;
BEGIN
  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE id = p_session_id;
  IF session.id IS NULL THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = '42501';
  END IF;

  IF p_run_id IS NOT NULL THEN
    SELECT * INTO run
    FROM public.agent_runs
    WHERE id = p_run_id
    FOR UPDATE;
  ELSE
    SELECT * INTO run
    FROM public.agent_runs candidate
    WHERE candidate.workspace_id = session.workspace_id
      AND candidate.agent_id = session.agent_id
      AND candidate.trigger = 'session_notes'
      AND candidate.scope ->> 'session_id' = session.id::text
      AND candidate.scope ->> 'session_phase' = 'final'
      AND candidate.scope ->> 'session_attempt' = p_attempt::text
    ORDER BY candidate.created_at DESC
    LIMIT 1
    FOR UPDATE;
  END IF;

  -- Keep the same run -> session lock order as agent_finish_run/status sync.
  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE id = p_session_id
  FOR UPDATE;
  IF session.id IS NULL THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = '42501';
  END IF;

  IF run.id IS NOT NULL AND (
       run.workspace_id IS DISTINCT FROM session.workspace_id
       OR run.agent_id IS DISTINCT FROM session.agent_id
       OR run.trigger <> 'session_notes'
       OR run.scope ->> 'session_id' IS DISTINCT FROM session.id::text
       OR run.scope ->> 'channel_id' IS DISTINCT FROM session.channel_id::text
       OR run.scope ->> 'session_phase' IS DISTINCT FROM 'final'
       OR run.scope ->> 'session_attempt' IS DISTINCT FROM p_attempt::text
       OR run.destination ->> 'type' IS DISTINCT FROM 'channel'
       OR run.destination ->> 'channel_id' IS DISTINCT FROM session.channel_id::text
     ) THEN
    RAISE EXCEPTION 'Final notes run does not belong to this session attempt'
      USING ERRCODE = '42501';
  END IF;

  IF run.id IS NOT NULL
     AND session.notes_run_id = run.id
     AND session.notes_status IN ('queued', 'running', 'completed') THEN
    RETURN session;
  END IF;

  IF run.id IS NULL THEN
    may_fail_reservation := true;
  ELSIF run.status = 'queued' THEN
    PERFORM public.agent_finish_run(
      run.id, NULL, 'failed', NULL, NULL,
      'setup_failed', 'The final notes run could not be started.'
    );
    may_fail_reservation := true;
  ELSIF run.status IN ('failed', 'cancelled', 'interrupted') THEN
    may_fail_reservation := true;
  END IF;

  IF may_fail_reservation THEN
    UPDATE public.conversation_ai_sessions
    SET notes_status = 'failed'
    WHERE id = session.id
      AND notes_attempt = p_attempt
      AND notes_status IN ('reserving', 'queued')
      AND (notes_run_id IS NULL OR notes_run_id = run.id)
    RETURNING * INTO session;
  END IF;

  IF session.id IS NULL THEN
    SELECT * INTO session
    FROM public.conversation_ai_sessions
    WHERE id = p_session_id;
  END IF;
  RETURN session;
END $$;

-- Mirror terminal/progress state onto the participant-readable session row.
-- This lets both DM participants see when questions have actually been posted,
-- without granting either participant direct access to the other's run row.
CREATE OR REPLACE FUNCTION public.sync_ai_session_review_status()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
BEGIN
  UPDATE public.conversation_ai_sessions AS session
  SET review_status = NEW.status
  WHERE session.review_run_id = NEW.id
    AND session.abandoned_at IS NULL
    AND NEW.trigger = 'session_notes'
    AND NEW.scope ->> 'session_phase' = 'review'
    AND NEW.scope ->> 'session_id' = session.id::text
    AND NEW.scope ->> 'channel_id' = session.channel_id::text
    AND NEW.destination ->> 'type' = 'channel'
    AND NEW.destination ->> 'channel_id' = session.channel_id::text
    AND NEW.workspace_id = session.workspace_id
    AND NEW.agent_id = session.agent_id
    AND session.review_status IS DISTINCT FROM NEW.status;
  UPDATE public.conversation_ai_sessions AS session
  SET notes_status = NEW.status
  WHERE session.notes_run_id = NEW.id
    AND session.abandoned_at IS NULL
    AND NEW.trigger = 'session_notes'
    AND NEW.scope ->> 'session_phase' = 'final'
    AND NEW.scope ->> 'session_id' = session.id::text
    AND NEW.scope ->> 'channel_id' = session.channel_id::text
    AND NEW.destination ->> 'type' = 'channel'
    AND NEW.destination ->> 'channel_id' = session.channel_id::text
    AND NEW.workspace_id = session.workspace_id
    AND NEW.agent_id = session.agent_id
    AND session.notes_status IS DISTINCT FROM NEW.status;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_agent_runs_ai_session_review_status
  ON public.agent_runs;
CREATE TRIGGER trg_agent_runs_ai_session_review_status
AFTER UPDATE OF status ON public.agent_runs
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.sync_ai_session_review_status();

-- A final provider turn may fail after submit_tasks_for_approval has already
-- committed. A new notes attempt must reuse those durable requests instead of
-- creating duplicates with a different run/tool id.
CREATE TABLE IF NOT EXISTS public.ai_session_task_submissions (
  session_id uuid NOT NULL
    REFERENCES public.conversation_ai_sessions(id) ON DELETE CASCADE,
  tasks_hash text NOT NULL,
  run_id uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  outcome text NOT NULL DEFAULT 'submitted'
    CHECK (outcome IN ('submitted', 'no_action_items')),
  request_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, tasks_hash)
);
ALTER TABLE public.ai_session_task_submissions
  ADD COLUMN IF NOT EXISTS run_id uuid
    REFERENCES public.agent_runs(id) ON DELETE SET NULL;
ALTER TABLE public.ai_session_task_submissions
  ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'submitted';
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.ai_session_task_submissions'::regclass
      AND conname = 'ai_session_task_submissions_outcome_check'
  ) THEN
    ALTER TABLE public.ai_session_task_submissions
      ADD CONSTRAINT ai_session_task_submissions_outcome_check
      CHECK (outcome IN ('submitted', 'no_action_items'));
  END IF;
END $$;
UPDATE public.ai_session_task_submissions submission
SET run_id = (
  SELECT task_request.agent_run_id
  FROM public.task_requests task_request
  WHERE task_request.id = ANY(submission.request_ids)
    AND task_request.agent_run_id IS NOT NULL
  LIMIT 1
)
WHERE submission.run_id IS NULL;

-- Upgrade safety: final-note runs that submitted approval requests before this
-- ledger existed must participate in replacement/deduplication too. The old
-- tool did not persist its input JSON, so use a reserved legacy fingerprint;
-- a retry can safely supersede still-pending requests, while an already
-- reviewed request remains authoritative and blocks a duplicate.
INSERT INTO public.ai_session_task_submissions (
  session_id, tasks_hash, run_id, request_ids, created_at
)
SELECT session.id,
       'legacy:' || md5(run.id::text),
       run.id,
       array_agg(request.id ORDER BY request.created_at, request.id),
       min(request.created_at)
FROM public.conversation_ai_sessions session
JOIN public.agent_runs run ON run.id = session.notes_run_id
JOIN public.task_requests request ON request.agent_run_id = run.id
WHERE NOT EXISTS (
  SELECT 1
  FROM public.ai_session_task_submissions existing
  WHERE existing.session_id = session.id
    AND request.id = ANY(existing.request_ids)
)
GROUP BY session.id, run.id
ON CONFLICT (session_id, tasks_hash) DO NOTHING;

-- There is exactly one authoritative complete batch per session, including an
-- explicit zero-task outcome. Reconcile any rows written by an earlier draft
-- of this migration before installing the uniqueness invariant. A reviewed
-- batch always wins; two independently reviewed batches require manual repair
-- rather than silently discarding a real task.
DO $$ BEGIN
  IF EXISTS (
    SELECT submission.session_id
    FROM public.ai_session_task_submissions submission
    WHERE EXISTS (
      SELECT 1
      FROM public.task_requests request
      WHERE request.id = ANY(submission.request_ids)
        AND request.status <> 'pending'
    )
    GROUP BY submission.session_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Conflicting reviewed AI session task outcomes require manual repair';
  END IF;
END $$;

WITH ranked AS (
  SELECT submission.session_id,
         submission.tasks_hash,
         submission.request_ids,
         row_number() OVER (
           PARTITION BY submission.session_id
           ORDER BY
             EXISTS (
               SELECT 1
               FROM public.task_requests request
               WHERE request.id = ANY(submission.request_ids)
                 AND request.status <> 'pending'
             ) DESC,
             (submission.run_id = session.notes_run_id) DESC NULLS LAST,
             submission.created_at DESC,
             submission.tasks_hash DESC
         ) AS position
  FROM public.ai_session_task_submissions submission
  JOIN public.conversation_ai_sessions session ON session.id = submission.session_id
), losing_request AS (
  SELECT request_id
  FROM ranked,
       unnest(ranked.request_ids) request_id
  WHERE ranked.position > 1
)
UPDATE public.task_requests request
SET status = 'rejected',
    decided_by = NULL,
    decided_at = now(),
    decision_note = 'Superseded by the authoritative AI session notes outcome',
    updated_at = now()
WHERE request.id IN (SELECT request_id FROM losing_request)
  AND request.status = 'pending';

WITH ranked AS (
  SELECT submission.session_id,
         submission.tasks_hash,
         row_number() OVER (
           PARTITION BY submission.session_id
           ORDER BY
             EXISTS (
               SELECT 1
               FROM public.task_requests request
               WHERE request.id = ANY(submission.request_ids)
                 AND request.status <> 'pending'
             ) DESC,
             (submission.run_id = session.notes_run_id) DESC NULLS LAST,
             submission.created_at DESC,
             submission.tasks_hash DESC
         ) AS position
  FROM public.ai_session_task_submissions submission
  JOIN public.conversation_ai_sessions session ON session.id = submission.session_id
)
DELETE FROM public.ai_session_task_submissions submission
USING ranked
WHERE ranked.session_id = submission.session_id
  AND ranked.tasks_hash = submission.tasks_hash
  AND ranked.position > 1;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.ai_session_task_submissions'::regclass
      AND conname = 'ai_session_task_submissions_one_outcome'
  ) THEN
    ALTER TABLE public.ai_session_task_submissions
      ADD CONSTRAINT ai_session_task_submissions_one_outcome
      UNIQUE (session_id);
  END IF;
END $$;

ALTER TABLE public.ai_session_task_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_session_task_submissions
  FROM PUBLIC, anon, authenticated;

DO $$ BEGIN
  IF to_regprocedure(
    'public.agent_submit_task_requests_pre_session_dedupe(uuid,text,jsonb,text)'
  ) IS NULL THEN
    ALTER FUNCTION public.agent_submit_task_requests(uuid, text, jsonb, text)
      RENAME TO agent_submit_task_requests_pre_session_dedupe;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_submit_task_requests(
  p_run_id uuid,
  p_tool_use_id text,
  p_tasks jsonb,
  p_source_label text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  run public.agent_runs%ROWTYPE;
  session public.conversation_ai_sessions%ROWTYPE;
  v_session_id uuid;
  v_tasks_hash text;
  existing_hash text;
  existing_run_id uuid;
  existing_ids uuid[];
  existing_outcome text;
  prior_ids uuid[];
  approver_ids uuid[];
  result jsonb;
  result_ids uuid[];
  result_outcome text;
BEGIN
  SELECT * INTO run
  FROM public.agent_runs
  WHERE id = p_run_id
  FOR UPDATE;
  IF run.id IS NULL OR run.status <> 'running'
     OR run.cancel_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'Run is not active' USING ERRCODE = '55000';
  END IF;

  IF run.trigger = 'session_notes'
     AND run.scope ->> 'session_phase' = 'final' THEN
    v_session_id := nullif(run.scope ->> 'session_id', '')::uuid;
  END IF;

  IF v_session_id IS NOT NULL THEN
    SELECT * INTO session
    FROM public.conversation_ai_sessions
    WHERE id = v_session_id
      AND workspace_id = run.workspace_id
      AND agent_id = run.agent_id
      AND notes_run_id = run.id
      AND abandoned_at IS NULL
    FOR UPDATE;
    IF session.id IS NULL THEN
      RAISE EXCEPTION 'Final notes run is not attached to an active notes session'
        USING ERRCODE = '55000';
    END IF;
    IF NOT public.user_is_channel_member(session.channel_id, run.requested_by)
       OR NOT public.ai_session_actor_can_control(session.id, run.requested_by)
       OR run.scope ->> 'channel_id' IS DISTINCT FROM session.channel_id::text
       OR run.destination ->> 'type' IS DISTINCT FROM 'channel'
       OR run.destination ->> 'channel_id' IS DISTINCT FROM session.channel_id::text THEN
      RAISE EXCEPTION 'The requester can no longer use this notes session'
        USING ERRCODE = '42501';
    END IF;
    IF jsonb_typeof(p_tasks) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_tasks) > 25 THEN
      RAISE EXCEPTION 'Submit between 0 and 25 session tasks'
        USING ERRCODE = '22023';
    END IF;

    -- jsonb text has stable object-key ordering. Exact retries reuse the
    -- original durable request ids.
    v_tasks_hash := md5(coalesce(p_tasks, 'null'::jsonb)::text);
    SELECT submission.tasks_hash, submission.run_id,
           submission.request_ids, submission.outcome
    INTO existing_hash, existing_run_id, existing_ids, existing_outcome
    FROM public.ai_session_task_submissions submission
    WHERE submission.session_id = session.id
    FOR UPDATE;

    IF FOUND AND existing_hash = v_tasks_hash THEN
      IF existing_outcome = 'no_action_items' THEN
        IF cardinality(existing_ids) <> 0 THEN
          RAISE EXCEPTION 'The saved no-action-items outcome is inconsistent'
            USING ERRCODE = '55000';
        END IF;
        UPDATE public.ai_session_task_submissions submission
        SET run_id = run.id
        WHERE submission.session_id = session.id;
        RETURN jsonb_build_object(
          'status', 'no_action_items',
          'request_ids', '[]'::jsonb,
          'new', 0,
          'approvers', 0,
          'requester_is_approver', false
        );
      END IF;

      IF existing_outcome <> 'submitted'
         OR cardinality(existing_ids) = 0 THEN
        RAISE EXCEPTION 'The saved session task outcome is inconsistent'
          USING ERRCODE = '55000';
      END IF;

      -- Serialize with project-manager decisions. Without these stable row
      -- locks an approval could commit after the status check but before the
      -- replacement update, producing both an approved task and its retry.
      PERFORM request.id
      FROM public.task_requests request
      WHERE request.id = ANY(existing_ids)
      ORDER BY request.id
      FOR UPDATE;

      IF (
        SELECT count(DISTINCT request.id)
        FROM public.task_requests request
        WHERE request.id = ANY(existing_ids)
      ) <> cardinality(existing_ids) THEN
        RAISE EXCEPTION 'The saved session task outcome is incomplete'
          USING ERRCODE = '55000';
      END IF;

      -- Explicit run cancellation rejects its requests. A later user retry may
      -- prepare that exact batch again; provider failures keep it reusable.
      IF EXISTS (
        SELECT 1
        FROM public.task_requests request
        WHERE request.id = ANY(existing_ids)
          AND NOT (
            request.status = 'rejected'
            AND request.decision_note = 'Agent run cancelled'
          )
      ) THEN
        -- The exact batch is now authoritative for this final attempt. Rebind
        -- its request provenance so conversation visibility follows only the
        -- current attached notes run.
        UPDATE public.task_requests request
        SET agent_run_id = run.id,
            updated_at = now()
        WHERE request.id = ANY(existing_ids)
          AND request.agent_run_id IS DISTINCT FROM run.id;
        UPDATE public.ai_session_task_submissions submission
        SET run_id = run.id
        WHERE submission.session_id = session.id;
        approver_ids := public.task_approver_ids(run.workspace_id);
        RETURN jsonb_build_object(
          'status', 'submitted',
          'request_ids', to_jsonb(existing_ids),
          'new', 0,
          'approvers', coalesce(array_length(approver_ids, 1), 0),
          'requester_is_approver', run.requested_by = ANY(approver_ids)
        );
      END IF;
      DELETE FROM public.ai_session_task_submissions submission
      WHERE submission.session_id = session.id;
    END IF;

    -- A final-notes turn must submit its complete task list in one batch. A
    -- second, different batch in the same run would make replacement order
    -- provider-dependent, so reject it instead of silently dropping tasks.
    IF existing_hash IS DISTINCT FROM v_tasks_hash
       AND existing_run_id = run.id THEN
      RAISE EXCEPTION 'Submit the complete session task list in one batch'
        USING ERRCODE = '55000';
    END IF;

    prior_ids := CASE
      WHEN existing_hash IS DISTINCT FROM v_tasks_hash
        THEN coalesce(existing_ids, '{}'::uuid[])
      ELSE '{}'::uuid[]
    END;

    IF coalesce(array_length(prior_ids, 1), 0) > 0 THEN
      PERFORM request.id
      FROM public.task_requests request
      WHERE request.id = ANY(prior_ids)
      ORDER BY request.id
      FOR UPDATE;

      IF (
        SELECT count(DISTINCT request.id)
        FROM public.task_requests request
        WHERE request.id = ANY(prior_ids)
      ) <> cardinality(prior_ids) THEN
        RAISE EXCEPTION 'The earlier session task outcome is incomplete'
          USING ERRCODE = '55000';
      END IF;

      -- A corrected retry may replace only requests that are still pending (or
      -- were automatically rejected because their run was cancelled). Once a
      -- project manager has decided one, creating another version could create
      -- two real tasks, so stop and keep the reviewed result authoritative.
      IF EXISTS (
        SELECT 1
        FROM public.task_requests request
        WHERE request.id = ANY(prior_ids)
          AND request.status <> 'pending'
          AND NOT (
            request.status = 'rejected'
            AND request.decision_note = 'Agent run cancelled'
          )
      ) THEN
        RAISE EXCEPTION 'Earlier session task requests were already reviewed and cannot be replaced'
          USING ERRCODE = '55000';
      END IF;

      UPDATE public.task_requests
      SET status = 'rejected',
          decided_by = NULL,
          decided_at = now(),
          decision_note = 'Superseded by corrected AI session notes',
          updated_at = now()
      WHERE id = ANY(prior_ids)
        AND status = 'pending';
    END IF;

    -- A prior explicit no-action outcome has no request ids, but it is still a
    -- mutually exclusive final batch. Remove every older fingerprint once any
    -- real requests have been safely locked/rejected above, otherwise a later
    -- exact empty retry could revive "no action items" beside pending tasks.
    DELETE FROM public.ai_session_task_submissions submission
    WHERE submission.session_id = session.id
      AND submission.tasks_hash IS DISTINCT FROM v_tasks_hash;

    IF jsonb_array_length(p_tasks) = 0 THEN
      result_outcome := 'no_action_items';
      result_ids := '{}'::uuid[];
      result := jsonb_build_object(
        'status', 'no_action_items',
        'request_ids', '[]'::jsonb,
        'new', 0,
        'approvers', 0,
        'requester_is_approver', false
      );
    ELSE
      result_outcome := 'submitted';
      result := public.agent_submit_task_requests_pre_session_dedupe(
        p_run_id, p_tool_use_id, p_tasks, p_source_label
      );
      result_ids := ARRAY(
        SELECT value::uuid
        FROM jsonb_array_elements_text(coalesce(result -> 'request_ids', '[]'::jsonb)) value
      );
      IF cardinality(result_ids) = 0 THEN
        RAISE EXCEPTION 'Task approval requests were not persisted'
          USING ERRCODE = '55000';
      END IF;
    END IF;
    INSERT INTO public.ai_session_task_submissions (
      session_id, tasks_hash, run_id, outcome, request_ids
    ) VALUES (
      session.id, v_tasks_hash, run.id, result_outcome, result_ids
    );
    RETURN result;
  END IF;

  RETURN public.agent_submit_task_requests_pre_session_dedupe(
    p_run_id, p_tool_use_id, p_tasks, p_source_label
  );
END $$;

-- One shared predicate protects final-session preflight, publication and
-- completion. It accepts an explicit empty outcome, but only when that exact
-- attached run owns the session's sole internally consistent ledger row.
CREATE OR REPLACE FUNCTION public.agent_session_outcome_ready(
  p_run_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
  SELECT coalesce((
    SELECT CASE
      WHEN run.trigger <> 'session_notes'
        OR run.scope ->> 'session_phase' <> 'final'
        THEN true
      ELSE EXISTS (
        SELECT 1
        FROM public.conversation_ai_sessions session
        JOIN public.ai_session_task_submissions submission
          ON submission.session_id = session.id
         AND submission.run_id = run.id
        WHERE session.id = nullif(run.scope ->> 'session_id', '')::uuid
          AND session.workspace_id = run.workspace_id
          AND session.agent_id = run.agent_id
          AND session.notes_run_id = run.id
          AND session.channel_id::text = run.scope ->> 'channel_id'
          AND session.channel_id::text = run.destination ->> 'channel_id'
          AND run.destination ->> 'type' = 'channel'
          AND session.abandoned_at IS NULL
          AND run.cancel_requested_at IS NULL
          AND public.ai_session_actor_can_control(session.id, run.requested_by)
          AND (
            (
              submission.outcome = 'no_action_items'
              AND cardinality(submission.request_ids) = 0
            )
            OR (
              submission.outcome = 'submitted'
              AND cardinality(submission.request_ids) > 0
              AND (
                SELECT count(DISTINCT request.id)
                FROM public.task_requests request
                WHERE request.id = ANY(submission.request_ids)
                  AND request.workspace_id = run.workspace_id
                  AND request.agent_run_id = run.id
              ) = cardinality(submission.request_ids)
            )
          )
      )
    END
    FROM public.agent_runs run
    WHERE run.id = p_run_id
  ), false);
$$;

-- A final notes run is not complete merely because the model produced prose.
-- It must durably call submit_tasks_for_approval, with either its full task
-- batch or an explicit empty batch recording that there are no action items.
CREATE OR REPLACE FUNCTION public.require_ai_session_final_outcome()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NEW.status = 'completed'
     AND OLD.status IS DISTINCT FROM 'completed'
     AND NEW.trigger = 'session_notes'
     AND NEW.scope ->> 'session_phase' = 'final'
     AND NOT public.agent_session_outcome_ready(NEW.id) THEN
    RAISE EXCEPTION 'Final session notes require a durable task outcome. Submit the complete task list, or submit an empty list when there are no action items.'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_agent_runs_ai_session_final_outcome
  ON public.agent_runs;
CREATE TRIGGER trg_agent_runs_ai_session_final_outcome
BEFORE UPDATE OF status ON public.agent_runs
FOR EACH ROW
EXECUTE FUNCTION public.require_ai_session_final_outcome();

-- The RLS policy needs to prove that a request really came from the final run
-- attached to a shared AI session. Keep that join behind a narrow boolean
-- helper so agent_runs RLS cannot hide it from other conversation members.
CREATE OR REPLACE FUNCTION public.ai_session_task_request_visible(
  p_run_id uuid,
  p_channel_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.agent_runs run
      JOIN public.conversation_ai_sessions session
        ON run.scope ->> 'session_id' = session.id::text
      WHERE run.id = p_run_id
        AND run.workspace_id = session.workspace_id
        AND run.agent_id = session.agent_id
        AND session.notes_run_id = run.id
        AND session.channel_id = p_channel_id
        AND session.abandoned_at IS NULL
        AND run.trigger = 'session_notes'
        AND run.scope ->> 'session_phase' = 'final'
        AND run.scope ->> 'channel_id' = session.channel_id::text
        AND run.destination ->> 'type' = 'channel'
        AND run.destination ->> 'channel_id' = session.channel_id::text
        AND public.user_is_channel_member(session.channel_id, (SELECT auth.uid()))
    );
$$;

-- Everyone who can still open the source conversation can follow the requests
-- prepared from its final session notes; project managers retain their
-- workspace-wide view.
DROP POLICY IF EXISTS "task_requests_read" ON public.task_requests;
CREATE POLICY "task_requests_read"
ON public.task_requests FOR SELECT TO authenticated
USING (
  public.user_is_workspace_member(workspace_id, auth.uid())
  AND (
    submitted_by = auth.uid()
    OR public.is_task_approver(workspace_id, auth.uid())
    OR (
      agent_run_id IS NOT NULL
      AND source_channel_id IS NOT NULL
      AND public.ai_session_task_request_visible(agent_run_id, source_channel_id)
    )
  )
);

-- Gate the irreversible channel write itself. A worker bug, old deployment or
-- direct service call cannot publish final notes and only then discover at
-- completion that it omitted the durable task/no-action outcome.
DO $$ BEGIN
  IF to_regprocedure(
    'public.agent_publish_reply_pre_session_outcome(uuid,text)'
  ) IS NULL THEN
    ALTER FUNCTION public.agent_publish_reply(uuid, text)
      RENAME TO agent_publish_reply_pre_session_outcome;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.agent_publish_reply(
  p_run_id uuid,
  p_content text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  run public.agent_runs%ROWTYPE;
  session public.conversation_ai_sessions%ROWTYPE;
  v_session_id uuid;
  v_phase text;
BEGIN
  SELECT * INTO run
  FROM public.agent_runs
  WHERE id = p_run_id
  FOR UPDATE;
  IF run.id IS NULL THEN
    RETURN jsonb_build_object('status', 'not_running');
  END IF;

  IF run.trigger = 'session_notes' THEN
    BEGIN
      v_session_id := nullif(run.scope ->> 'session_id', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN jsonb_build_object('status', 'session_invalid');
    END;
    v_phase := run.scope ->> 'session_phase';
    SELECT * INTO session
    FROM public.conversation_ai_sessions candidate
    WHERE candidate.id = v_session_id
      AND candidate.workspace_id = run.workspace_id
      AND candidate.agent_id = run.agent_id
      AND candidate.channel_id::text = run.scope ->> 'channel_id'
      AND candidate.channel_id::text = run.destination ->> 'channel_id'
      AND run.destination ->> 'type' = 'channel'
      AND (
        (v_phase = 'review' AND candidate.review_run_id = run.id)
        OR (v_phase = 'final' AND candidate.notes_run_id = run.id)
      )
    FOR UPDATE;
    IF session.id IS NULL THEN
      RETURN jsonb_build_object('status', 'session_invalid');
    END IF;
    IF session.abandoned_at IS NOT NULL THEN
      RETURN jsonb_build_object(
        'status', 'cancelled', 'reason', 'session_abandoned'
      );
    END IF;
    IF NOT public.ai_session_actor_can_control(session.id, run.requested_by) THEN
      RETURN jsonb_build_object('status', 'private', 'reason', 'not_member');
    END IF;
    IF v_phase = 'final'
       AND NOT public.agent_session_outcome_ready(run.id) THEN
      RETURN jsonb_build_object('status', 'session_outcome_missing');
    END IF;
  END IF;

  RETURN public.agent_publish_reply_pre_session_outcome(p_run_id, p_content);
END $$;

-- agent_publish_reply returns `exists` for every prior proposal, including a
-- failed one. The worker may treat `exists` as success only when the proposal
-- actually produced the channel message for this run.
CREATE OR REPLACE FUNCTION public.agent_session_reply_was_published(
  p_run_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.agent_runs run
    JOIN public.agent_action_proposals proposal
      ON proposal.run_id = run.id
     AND proposal.workspace_id = run.workspace_id
    JOIN public.messages message
      ON message.agent_run_id = run.id
     AND message.id::text = proposal.result ->> 'message_id'
    WHERE run.id = p_run_id
      AND run.trigger = 'session_notes'
      AND proposal.action_type = 'post_message'
      AND proposal.idempotency_key = 'reply:' || run.id::text
      AND proposal.status = 'executed'
      AND message.deleted_at IS NULL
      AND message.channel_id::text = run.destination ->> 'channel_id'
  );
$$;

-- Explicitly abandon a stuck session without manufacturing final notes. This
-- transaction never locks an agent run, so it cannot deadlock a worker that
-- already owns run -> session through the status-sync trigger.
CREATE OR REPLACE FUNCTION public.ai_session_abandon(
  p_actor uuid,
  p_session_id uuid
) RETURNS public.conversation_ai_sessions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  session public.conversation_ai_sessions%ROWTYPE;
  human_message_count integer;
BEGIN
  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE id = p_session_id
  FOR UPDATE;
  IF session.id IS NULL
     OR NOT public.user_is_channel_member(session.channel_id, p_actor)
     OR NOT (
       EXISTS (
         SELECT 1 FROM public.direct_conversations conversation
         WHERE conversation.channel_id = session.channel_id
       )
       OR session.started_by = p_actor
       OR EXISTS (
         SELECT 1 FROM public.channels channel
         WHERE channel.id = session.channel_id
           AND channel.created_by = p_actor
       )
       OR public.user_is_workspace_admin(session.workspace_id, p_actor)
     ) THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = '42501';
  END IF;
  IF session.abandoned_at IS NOT NULL THEN
    RETURN session;
  END IF;
  IF session.status = 'finished'
     AND session.notes_status NOT IN (
       'reserving', 'queued', 'running', 'failed', 'cancelled', 'interrupted'
     ) THEN
    RAISE EXCEPTION 'This notes session is already complete'
      USING ERRCODE = '55000';
  END IF;

  IF session.status = 'active' THEN
    SELECT count(*)::integer INTO human_message_count
    FROM public.messages message
    WHERE message.channel_id = session.channel_id
      AND message.deleted_at IS NULL
      AND message.agent_id IS NULL
      AND message.created_at >= session.started_at
      AND message.created_at <= now();
  ELSE
    human_message_count := coalesce(session.message_count, 0);
  END IF;

  UPDATE public.conversation_ai_sessions
  SET status = 'finished',
      ended_by = coalesce(ended_by, p_actor),
      ended_at = coalesce(ended_at, now()),
      message_count = human_message_count,
      abandoned_by = p_actor,
      abandoned_at = now(),
      review_status = CASE
        WHEN review_status IN ('reserving', 'queued', 'running') THEN 'cancelled'
        ELSE review_status
      END,
      -- Finished sessions with cancelled/failed notes are deliberately visible
      -- for retry. NULL makes this explicit abandonment stay out of that view;
      -- the sync trigger also ignores abandoned rows.
      notes_status = NULL
  WHERE id = session.id
  RETURNING * INTO session;
  RETURN session;
END $$;

-- Best-effort cancellation of a run belonging to an already-abandoned
-- session. Lock run first, matching agent_finish_run and status-sync order.
CREATE OR REPLACE FUNCTION public.ai_session_cancel_abandoned_run(
  p_actor uuid,
  p_session_id uuid,
  p_run_id uuid
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  session public.conversation_ai_sessions%ROWTYPE;
  run public.agent_runs%ROWTYPE;
  result text;
BEGIN
  SELECT * INTO run
  FROM public.agent_runs
  WHERE id = p_run_id
  FOR UPDATE;
  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE id = p_session_id;

  IF session.id IS NULL
     OR session.abandoned_at IS NULL
     OR NOT public.user_is_channel_member(session.channel_id, p_actor)
     OR NOT (
       EXISTS (
         SELECT 1 FROM public.direct_conversations conversation
         WHERE conversation.channel_id = session.channel_id
       )
       OR session.started_by = p_actor
       OR EXISTS (
         SELECT 1 FROM public.channels channel
         WHERE channel.id = session.channel_id
           AND channel.created_by = p_actor
       )
       OR public.user_is_workspace_admin(session.workspace_id, p_actor)
     ) THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = '42501';
  END IF;
  IF run.id IS NULL
     OR run.workspace_id IS DISTINCT FROM session.workspace_id
     OR run.agent_id IS DISTINCT FROM session.agent_id
     OR run.trigger <> 'session_notes'
     OR run.scope ->> 'session_id' IS DISTINCT FROM session.id::text
     OR run.scope ->> 'channel_id' IS DISTINCT FROM session.channel_id::text
     OR run.destination ->> 'type' IS DISTINCT FROM 'channel'
     OR run.destination ->> 'channel_id' IS DISTINCT FROM session.channel_id::text
     OR (
       (
         run.id = session.review_run_id
         AND run.scope ->> 'session_phase' IS DISTINCT FROM 'review'
       )
       OR (
         run.id = session.notes_run_id
         AND run.scope ->> 'session_phase' IS DISTINCT FROM 'final'
       )
       OR (
         run.id IS DISTINCT FROM session.review_run_id
         AND run.id IS DISTINCT FROM session.notes_run_id
       )
     ) THEN
    RAISE EXCEPTION 'Run does not belong to this notes session'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.agent_action_proposals
  SET status = 'cancelled', error = 'Session cancelled'
  WHERE run_id = run.id
    AND status = 'pending';

  IF run.status = 'queued' THEN
    result := public.agent_finish_run(
      run.id, NULL, 'cancelled', NULL, NULL,
      'cancelled', 'Session cancelled.'
    );
  ELSIF run.status = 'running' THEN
    UPDATE public.agent_runs
    SET cancel_requested_at = coalesce(cancel_requested_at, now())
    WHERE id = run.id;
    result := 'cancelling';
  ELSE
    result := run.status;
  END IF;

  -- Abandonment is authoritative even when the worker already failed or was
  -- interrupted after persisting task proposals. Such proposals must never
  -- remain approvable after the user explicitly ends the notes session.
  IF run.status <> 'completed' THEN
    UPDATE public.task_requests
    SET status = 'rejected',
        decided_at = coalesce(decided_at, now()),
        decision_note = coalesce(decision_note, 'AI notes session cancelled'),
        updated_at = now()
    WHERE agent_run_id = run.id
      AND status = 'pending';
  END IF;
  RETURN result;
END $$;

-- Finishing is the explicit second step. Sessions with human messages must
-- first have a persisted review run, so questions can be answered in-chat.
CREATE OR REPLACE FUNCTION public.ai_session_finish(
  p_actor uuid,
  p_session_id uuid
) RETURNS public.conversation_ai_sessions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp AS $$
DECLARE
  session public.conversation_ai_sessions%ROWTYPE;
  human_message_count integer;
BEGIN
  SELECT * INTO session
  FROM public.conversation_ai_sessions
  WHERE id = p_session_id
  FOR UPDATE;
  IF session.id IS NULL
     OR NOT public.ai_session_actor_can_control(session.id, p_actor) THEN
    RAISE EXCEPTION 'Session not found' USING ERRCODE = '42501';
  END IF;
  IF session.status = 'active' THEN
    SELECT count(*)::integer INTO human_message_count
    FROM public.messages message
    WHERE message.channel_id = session.channel_id
      AND message.deleted_at IS NULL
      AND message.agent_id IS NULL
      AND message.created_at >= session.started_at
      AND message.created_at <= now();

    IF human_message_count > 0
       AND (session.review_run_id IS NULL OR session.review_status <> 'completed') THEN
      IF session.review_status IN ('reserving', 'queued', 'running') THEN
        RAISE EXCEPTION 'Wait for the AI review before finishing this session'
          USING ERRCODE = '55000';
      ELSIF session.review_status IN ('failed', 'cancelled', 'interrupted') THEN
        RAISE EXCEPTION 'Retry the AI review before finishing this session'
          USING ERRCODE = '55000';
      ELSE
        RAISE EXCEPTION 'Review this session before finishing it'
          USING ERRCODE = '55000';
      END IF;
    END IF;

    UPDATE public.conversation_ai_sessions
    SET status = 'finished',
        ended_by = p_actor,
        ended_at = now(),
        message_count = human_message_count
    WHERE id = session.id
    RETURNING * INTO session;
  END IF;
  RETURN session;
END $$;

-- Removed compatibility RPC. It predates phase-bound review/final attempts
-- and could attach an arbitrary service-created run without validating its
-- workspace, agent, destination or session phase. All callers must use
-- ai_session_start_run, which creates and attaches the exact run atomically.
DROP FUNCTION IF EXISTS public.ai_session_attach_run(uuid, uuid);

REVOKE ALL ON FUNCTION public.ai_session_request_review(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_session_attach_review_run(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_session_fail_review_reservation(uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_session_fail_review_attempt(uuid, integer, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_session_fail_notes_attempt(uuid, integer, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_session_prepare_finish(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_session_request_finish(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_session_finish_with_run(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_session_finish(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_session_abandon(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_session_cancel_abandoned_run(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_submit_task_requests_pre_session_dedupe(uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_submit_task_requests(uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_publish_reply_pre_session_outcome(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_publish_reply(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_session_outcome_ready(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ai_session_transcript_for(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_session_actor_can_control(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_session_start_run(uuid, uuid, text, text, bigint)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_session_task_request_visible(uuid, uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.agent_session_reply_was_published(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.require_ai_session_final_outcome()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.ai_session_request_review(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_session_attach_review_run(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_session_fail_review_reservation(uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_session_fail_review_attempt(uuid, integer, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_session_fail_notes_attempt(uuid, integer, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_session_prepare_finish(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_session_request_finish(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_session_finish_with_run(uuid, uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_session_finish(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_session_abandon(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_session_cancel_abandoned_run(uuid, uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_submit_task_requests(uuid, text, jsonb, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_publish_reply(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_session_outcome_ready(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_session_transcript_for(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_session_actor_can_control(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_session_start_run(uuid, uuid, text, text, bigint)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_session_task_request_visible(uuid, uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agent_session_reply_was_published(uuid)
  TO service_role;

COMMENT ON COLUMN public.conversation_ai_sessions.review_run_id IS
  'Non-mutating review run posted while the session remains open for participant answers.';
COMMENT ON COLUMN public.conversation_ai_sessions.review_status IS
  'Participant-readable progress of the non-mutating review run.';
COMMENT ON COLUMN public.conversation_ai_sessions.review_requested_by IS
  'Participant whose quota and permissions own the serialized review attempt.';
COMMENT ON COLUMN public.conversation_ai_sessions.notes_status IS
  'Participant-readable final-notes progress; terminal failures can be retried with a new attempt.';
COMMENT ON COLUMN public.conversation_ai_sessions.notes_requested_by IS
  'Participant whose quota and permissions own the serialized final-notes attempt.';
COMMENT ON COLUMN public.conversation_ai_sessions.abandoned_at IS
  'Explicit user cancellation; abandoned sessions never reappear as retryable notes runs.';

NOTIFY pgrst, 'reload schema';
