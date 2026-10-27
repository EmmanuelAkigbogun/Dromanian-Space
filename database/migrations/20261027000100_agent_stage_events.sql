-- Agent progress stages are durable UI checkpoints. The worker already emits
-- them over its live stream; permit the same event type in persisted history.
ALTER TABLE public.agent_run_events
  DROP CONSTRAINT IF EXISTS agent_run_events_type_check;

ALTER TABLE public.agent_run_events
  ADD CONSTRAINT agent_run_events_type_check
  CHECK (type IN ('status', 'stage', 'tool_started', 'tool_finished', 'sources', 'proposal', 'warning', 'error'));
