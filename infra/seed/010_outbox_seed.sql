-- 인스턴스 테스트용 (없으면 하나 만들어두기)
insert into process_instance (id, status, created_at, updated_at)
values ('TEST', 'RUNNING', now(), now())
on conflict (id) do nothing;

-- outbox 테스트 이벤트
insert into event_outbox (
  instance_id, event_type, payload, created_at
) values
('TEST', 'INSTANCE_RUNNING', jsonb_build_object(
  'instance_id','TEST',
  'status','RUNNING',
  'timestamp', now()
), now()),
('TEST', 'NODE_STARTED', jsonb_build_object(
  'instance_id','TEST',
  'node_id','start',
  'token_id','t1',
  'timestamp', now()
), now()),
('TEST', 'NODE_COMPLETED', jsonb_build_object(
  'instance_id','TEST',
  'node_id','start',
  'token_id','t1',
  'timestamp', now()
), now());
