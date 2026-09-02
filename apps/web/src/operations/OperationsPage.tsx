import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, RotateCcw, ServerCog } from 'lucide-react';
import { operationsApi, type OperationsOverview } from '../api/operations';
import './OperationsPage.css';
import { useFeedback } from '../components/feedback/feedback-context';
import { PageHeader } from '../components';
import { deliveryStatusLabel } from '../lib/status-label';

const age = (ms: number | null) => {
  if (ms == null) return '-';
  if (ms < 60_000) return `${Math.round(ms / 1000)}초`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}분`;
  return `${Math.round(ms / 3_600_000)}시간`;
};

export function OperationsPage() {
  const { prompt: promptDialog } = useFeedback();
  const [data, setData] = useState<OperationsOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await operationsApi.overview()); } catch (e) { setError(e instanceof Error ? e.message : '조회 실패'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(load, 15_000); return () => window.clearInterval(timer); }, [load]);

  const run = async (key: string, label: string, fn: (reason: string) => Promise<unknown>) => {
    const reason = await promptDialog({
      title: `${label}을 실행할까요?`,
      description: '현재 상태를 다시 검증한 뒤 가능한 경우에만 처리합니다.',
      label: '처리 사유 (3자 이상)',
      confirmLabel: label,
    });
    if (!reason || reason.trim().length < 3) return;
    setActing(key); setError('');
    try { await fn(reason.trim()); await load(); } catch (e) { setError(e instanceof Error ? e.message : '운영 조치 실패'); }
    finally { setActing(''); }
  };

  return <div className="operations-page">
    <PageHeader
      className="operations-intro"
      aria-label="운영 현황 안내"
      icon={<ServerCog size={22} />}
      description="Job 적체, 장기 대기, 만료 잠금과 외부 전송 실패를 한곳에서 확인하고 안전하게 복구합니다."
      actions={<button onClick={load} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''}/>새로고침</button>}
    />
    {error && <div className="operations-error"><AlertTriangle size={15}/>{error}</div>}
    {data && <>
      <section className={`operations-health ${data.status.toLowerCase()}`}>
        {data.status === 'HEALTHY' ? <CheckCircle2/> : <AlertTriangle/>}
        <div>
          <strong>{data.status === 'HEALTHY' ? '정상' : data.status === 'WARNING' ? '주의 필요' : '즉시 확인 필요'}</strong>
          <small>{healthReason(data)} · 기준 시각 {new Date(data.generated_at).toLocaleString()}</small>
        </div>
      </section>
      <section className="operations-cards">
        <article><span>대기 Job</span><strong>{data.queue.queued}</strong><small>최장 {age(data.queue.oldest_queued_age_ms)}</small></article>
        <article><span>실행 / 실패 Job</span><strong>{data.queue.running} / {data.queue.failed}</strong><small>실패 건은 조건부 재시도</small></article>
        <article><span>의심 WAITING</span><strong>{data.runtime.suspicious_waiting_count}</strong><small>정상 장기 대기 {data.runtime.expected_waiting_count}건</small></article>
        <article><span>만료 잠금</span><strong>{data.runtime.expired_locks.length}</strong><small>현재 만료 상태만 회수</small></article>
        <article><span>Outbox 적체</span><strong>{data.outbox.pending + data.outbox.failed}</strong><small>DLQ {data.outbox.dead_letter}</small></article>
      </section>
      <OperationTable title="Engine Job" rows={data.runtime.jobs.filter(j => j.status === 'FAILED')} empty="실패 Job이 없습니다."
        render={(job) => <><code>{job.id}</code><span>{job.type}</span><span>시도 {job.attempt}</span><code>{job.instance_id}</code>
          <button disabled={acting === `job-${job.id}`} onClick={() => run(`job-${job.id}`, '실패 Job 재시도', r => operationsApi.retryJob(job.id, r))}><RotateCcw size={13}/>재시도</button></>}/>
      <OperationTable title="장기 WAITING 인스턴스" rows={data.runtime.waiting_instances} empty="기준 시간을 넘긴 WAITING 인스턴스가 없습니다."
        render={(instance) => <><code>{instance.id}</code>
          <span className={instance.classification === 'EXPECTED' ? 'expected' : 'status'}>
            {instance.classification === 'EXPECTED' ? '정상 대기' : '재개 근거 없음'}
          </span><span>{age(instance.waiting_age_ms)} 대기</span>
          <span>{waitingReason(instance)}</span></>}/>
      <OperationTable title="만료 인스턴스 잠금" rows={data.runtime.expired_locks} empty="만료된 잠금이 없습니다."
        render={(lock) => <><code>{lock.instance_id}</code><span>{lock.lock_owner}</span><span>{new Date(lock.lock_until).toLocaleString()}</span>
          <button disabled={acting === `lock-${lock.instance_id}`} onClick={() => run(`lock-${lock.instance_id}`, '만료 잠금 회수', r => operationsApi.reclaimLock(lock.instance_id, r))}><ServerCog size={13}/>잠금 회수</button></>}/>
      <OperationTable title="Outbox 전송 이상" rows={data.outbox.deliveries.filter(d => ['FAILED','DEAD_LETTER'].includes(d.status))} empty="실패한 전송이 없습니다."
        render={(delivery) => <><code>{delivery.id.slice(0, 12)}…</code><span>{delivery.endpoint_name}</span><span className="status">{deliveryStatusLabel(delivery.status)}</span><span>{delivery.last_error || delivery.event_type}</span>
          <button disabled={acting === `outbox-${delivery.id}`} onClick={() => run(`outbox-${delivery.id}`, 'Outbox 재전송', r => operationsApi.retryOutbox(delivery.id, r))}><RotateCcw size={13}/>재전송</button></>}/>
    </>}
  </div>;
}

function healthReason(data: OperationsOverview) {
  const reasons: string[] = [];
  if (data.queue.failed) reasons.push(`실패 Job ${data.queue.failed}건`);
  if (data.runtime.suspicious_waiting_count) reasons.push(`의심 WAITING ${data.runtime.suspicious_waiting_count}건`);
  if (data.runtime.expired_locks.length) reasons.push(`만료 잠금 ${data.runtime.expired_locks.length}건`);
  if (data.outbox.failed) reasons.push(`전송 실패 ${data.outbox.failed}건`);
  if (data.outbox.dead_letter) reasons.push(`DLQ ${data.outbox.dead_letter}건`);
  return reasons.length ? reasons.join(', ') : '운영 임계값 이내';
}

function waitingReason(instance: OperationsOverview['runtime']['waiting_instances'][number]) {
  if (instance.waiting_reason === 'OPEN_TASK') return `처리 가능한 승인 Task ${instance.open_task_count}건`;
  if (instance.waiting_reason === 'SCHEDULED_JOB') return `실행 예정 Job ${instance.scheduled_job_count}건`;
  if (instance.waiting_reason === 'ACTIVE_CHILD') return `진행 중 하위 실행 ${instance.active_child_count}건`;
  return 'Task, Job 또는 하위 실행이 없어 점검이 필요합니다.';
}

function OperationTable<T>({ title, rows, empty, render }: { title: string; rows: T[]; empty: string; render: (row: T) => React.ReactNode }) {
  return <section className="operations-table"><header><h3>{title}</h3><span>{rows.length}건</span></header>
    {rows.length ? <div>{rows.map((row, index) => <article key={index}>{render(row)}</article>)}</div> : <p>{empty}</p>}
  </section>;
}
