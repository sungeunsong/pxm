-- 인스턴스 업무 결과를 실행 상태와 분리해 1급 필드로 저장한다.
-- state가 종료 상태(COMPLETED / FAILED / TERMINATED)가 될 때 같은 트랜잭션에서 함께 기록한다.
--   outcome        SUCCESS | REJECTED | FAILURE | CANCELLED (진행 중이면 NULL)
--   outcome_reason { code, failure_type, retryable, message, node_id }
ALTER TABLE v2_process_instances
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS outcome_reason JSONB;

CREATE INDEX IF NOT EXISTS idx_v2_process_instances_outcome
  ON v2_process_instances (outcome, updated_at);
