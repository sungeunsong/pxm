ALTER TABLE v2_process_instances
  ADD COLUMN IF NOT EXISTS is_paused BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paused_by TEXT,
  ADD COLUMN IF NOT EXISTS pause_origin_instance_id UUID;

CREATE INDEX IF NOT EXISTS idx_v2_process_instances_pause_control
  ON v2_process_instances (is_paused, state, updated_at);
