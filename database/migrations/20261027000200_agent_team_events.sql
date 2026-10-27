-- Coordinator delegation updates are durable UI checkpoints, just like run
-- stages. Add the event kind the worker already persists during team runs.
ALTER TABLE public.agent_run_events
  DROP CONSTRAINT IF EXISTS agent_run_events_type_check;

ALTER TABLE public.agent_run_events
  ADD CONSTRAINT agent_run_events_type_check
  CHECK (type IN ('status', 'stage', 'team', 'tool_started', 'tool_finished', 'sources', 'proposal', 'warning', 'error'))
  NOT VALID;

ALTER TABLE public.agent_run_events
  VALIDATE CONSTRAINT agent_run_events_type_check;
