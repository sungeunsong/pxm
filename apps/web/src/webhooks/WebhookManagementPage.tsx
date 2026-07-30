import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleOff,
  Clock3,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Webhook,
  X,
} from 'lucide-react';
import {
  webhooksApi,
  type WebhookAttempt,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookEndpoint,
} from '../api/webhooks';
import './WebhookManagementPage.css';

const STATUS_LABELS: Record<WebhookDeliveryStatus, string> = {
  PENDING: '전송 대기',
  RUNNING: '전송 중',
  SENT: '전송 완료',
  FAILED: '재시도 대기',
  DEAD_LETTER: '최종 실패',
  CANCELED: '취소',
};

export function WebhookManagementPage() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [status, setStatus] = useState('');
  const [endpointId, setEndpointId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<
    (WebhookDelivery & { attempts?: WebhookAttempt[] }) | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [nextEndpoints, nextDeliveries] = await Promise.all([
        webhooksApi.endpoints(),
        webhooksApi.deliveries({
          status: status || undefined,
          endpoint_id: endpointId || undefined,
        }),
      ]);
      setEndpoints(nextEndpoints);
      setDeliveries(nextDeliveries);
    } catch (value) {
      setError(errorText(value));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [status, endpointId]);

  const summary = useMemo(
    () => ({
      sent: deliveries.filter((item) => item.status === 'SENT').length,
      waiting: deliveries.filter((item) =>
        ['PENDING', 'RUNNING', 'FAILED'].includes(item.status),
      ).length,
      dead: deliveries.filter((item) => item.status === 'DEAD_LETTER').length,
    }),
    [deliveries],
  );

  const toggleEndpoint = async (endpoint: WebhookEndpoint) => {
    setBusy(endpoint.id);
    setError('');
    try {
      await webhooksApi.updateEndpoint(endpoint.id, {
        active: !endpoint.active,
      });
      setMessage(
        `${endpoint.name} endpoint를 ${endpoint.active ? '비활성화' : '활성화'}했습니다.`,
      );
      await load();
    } catch (value) {
      setError(errorText(value));
    } finally {
      setBusy('');
    }
  };

  const openDelivery = async (delivery: WebhookDelivery) => {
    setBusy(delivery.id);
    setError('');
    try {
      setSelected(await webhooksApi.delivery(delivery.id));
    } catch (value) {
      setError(errorText(value));
    } finally {
      setBusy('');
    }
  };

  const retry = async (delivery: WebhookDelivery) => {
    if (!window.confirm('이 전송 건을 다시 전송 대기 상태로 바꿀까요?'))
      return;
    setBusy(delivery.id);
    setError('');
    try {
      await webhooksApi.retry(delivery.id);
      setMessage('재전송을 요청했습니다.');
      setSelected(null);
      await load();
    } catch (value) {
      setError(errorText(value));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="webhook-page">
      <section className="webhook-intro">
        <div>
          <span className="webhook-eyebrow">
            <Webhook size={15} /> 최고관리자 전용
          </span>
          <h2>외부 결과 Webhook</h2>
          <p>
            최종 승인·반려·취소 이벤트를 외부 시스템으로 전달하고 실패
            이력과 재시도를 관리합니다.
          </p>
        </div>
        <div className="webhook-intro-actions">
          <button className="secondary" onClick={() => void load()}>
            <RefreshCw size={15} /> 새로고침
          </button>
          <button onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> Endpoint 등록
          </button>
        </div>
      </section>

      {message && (
        <div className="webhook-message success">
          <CheckCircle2 size={16} />
          {message}
        </div>
      )}
      {error && (
        <div className="webhook-message error">
          <AlertTriangle size={16} />
          {error}
        </div>
      )}

      <section className="webhook-summary">
        <article>
          <span>활성 Endpoint</span>
          <strong>{endpoints.filter((item) => item.active).length}</strong>
          <small>전체 {endpoints.length}개</small>
        </article>
        <article className="sent">
          <span>전송 완료</span>
          <strong>{summary.sent}</strong>
          <small>현재 조회 범위</small>
        </article>
        <article className="waiting">
          <span>처리 대기</span>
          <strong>{summary.waiting}</strong>
          <small>대기·처리·재시도</small>
        </article>
        <article className="dead">
          <span>최종 실패</span>
          <strong>{summary.dead}</strong>
          <small>운영자 확인 필요</small>
        </article>
      </section>

      <section className="webhook-endpoints">
        <header>
          <div>
            <h3>등록된 Endpoint</h3>
            <p>URL과 Secret은 마스킹되어 표시됩니다.</p>
          </div>
        </header>
        <div className="webhook-endpoint-grid">
          {endpoints.map((endpoint) => (
            <article key={endpoint.id}>
              <div className="endpoint-title">
                <span className={endpoint.active ? 'active' : 'inactive'}>
                  {endpoint.active ? (
                    <CheckCircle2 size={13} />
                  ) : (
                    <CircleOff size={13} />
                  )}
                  {endpoint.active ? '활성' : '비활성'}
                </span>
                <strong>{endpoint.name}</strong>
              </div>
              <dl>
                <div>
                  <dt>Provider</dt>
                  <dd>{endpoint.source_provider}</dd>
                </div>
                <div>
                  <dt>URL</dt>
                  <dd>{endpoint.url}</dd>
                </div>
                <div>
                  <dt>Secret</dt>
                  <dd>{endpoint.secret_hint}</dd>
                </div>
                <div>
                  <dt>정책</dt>
                  <dd>
                    {endpoint.timeout_ms}ms · 최대 {endpoint.max_attempts}회
                  </dd>
                </div>
              </dl>
              <button
                className="endpoint-toggle"
                disabled={busy === endpoint.id}
                onClick={() => void toggleEndpoint(endpoint)}
              >
                {endpoint.active ? '비활성화' : '활성화'}
              </button>
            </article>
          ))}
          {!endpoints.length && !loading && (
            <div className="webhook-empty-card">
              등록된 Endpoint가 없습니다.
            </div>
          )}
        </div>
      </section>

      <section className="webhook-history">
        <header>
          <div>
            <h3>전송 이력</h3>
            <p>행을 선택하면 응답과 시도별 오류를 확인할 수 있습니다.</p>
          </div>
          <div className="webhook-filters">
            <select
              value={endpointId}
              onChange={(event) => setEndpointId(event.target.value)}
            >
              <option value="">모든 Endpoint</option>
              {endpoints.map((endpoint) => (
                <option key={endpoint.id} value={endpoint.id}>
                  {endpoint.name}
                </option>
              ))}
            </select>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">모든 상태</option>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </header>
        <div className="webhook-table-wrap">
          <table>
            <thead>
              <tr>
                <th>상태</th>
                <th>Endpoint</th>
                <th>이벤트</th>
                <th>실행</th>
                <th>시도</th>
                <th>HTTP</th>
                <th>발생 시각</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr
                  key={delivery.id}
                  onClick={() => void openDelivery(delivery)}
                >
                  <td>
                    <StatusBadge status={delivery.status} />
                  </td>
                  <td>{delivery.endpoint_name}</td>
                  <td>{eventLabel(delivery.event_type)}</td>
                  <td className="mono">{shortId(delivery.instance_id)}</td>
                  <td>{delivery.total_attempt_count}</td>
                  <td>{delivery.response_status || '—'}</td>
                  <td>{formatDate(delivery.occurred_at)}</td>
                  <td>
                    {['FAILED', 'DEAD_LETTER', 'CANCELED'].includes(
                      delivery.status,
                    ) && (
                      <button
                        className="retry"
                        disabled={busy === delivery.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          void retry(delivery);
                        }}
                      >
                        <RotateCcw size={13} /> 재전송
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!deliveries.length && (
            <div className="webhook-empty">
              {loading ? '불러오는 중…' : '조건에 맞는 전송 이력이 없습니다.'}
            </div>
          )}
        </div>
      </section>

      {createOpen && (
        <EndpointModal
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false);
            setMessage('Webhook Endpoint를 등록했습니다.');
            await load();
          }}
        />
      )}
      {selected && (
        <DeliveryDrawer delivery={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function EndpointModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: '',
    source_provider: '',
    url: '',
    secret: '',
    timeout_ms: 5000,
    max_attempts: 8,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await webhooksApi.createEndpoint(form);
      await onCreated();
    } catch (value) {
      setError(errorText(value));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="webhook-modal-backdrop" onMouseDown={onClose}>
      <form
        className="webhook-modal"
        onSubmit={(event) => void submit(event)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h3>Webhook Endpoint 등록</h3>
            <p>동일한 provider의 최종 결재 이벤트만 전달됩니다.</p>
          </div>
          <button type="button" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {error && <div className="webhook-form-error">{error}</div>}
        <label>
          이름
          <input
            required
            maxLength={100}
            value={form.name}
            onChange={(event) =>
              setForm({ ...form, name: event.target.value })
            }
            placeholder="AcraPoint 운영"
          />
        </label>
        <label>
          Source provider
          <input
            required
            maxLength={128}
            value={form.source_provider}
            onChange={(event) =>
              setForm({ ...form, source_provider: event.target.value })
            }
            placeholder="acrapoint"
          />
        </label>
        <label>
          Endpoint URL
          <input
            required
            type="url"
            value={form.url}
            onChange={(event) =>
              setForm({ ...form, url: event.target.value })
            }
            placeholder="https://acrapoint.example/webhooks/pxm"
          />
        </label>
        <label>
          HMAC Secret
          <input
            required
            type="password"
            minLength={32}
            value={form.secret}
            onChange={(event) =>
              setForm({ ...form, secret: event.target.value })
            }
            placeholder="32자 이상의 임의 문자열"
          />
          <small>저장 후 원문은 다시 표시되지 않습니다.</small>
        </label>
        <div className="webhook-form-row">
          <label>
            Timeout(ms)
            <input
              required
              type="number"
              min={500}
              max={30000}
              value={form.timeout_ms}
              onChange={(event) =>
                setForm({ ...form, timeout_ms: Number(event.target.value) })
              }
            />
          </label>
          <label>
            최대 시도
            <input
              required
              type="number"
              min={1}
              max={20}
              value={form.max_attempts}
              onChange={(event) =>
                setForm({ ...form, max_attempts: Number(event.target.value) })
              }
            />
          </label>
        </div>
        <footer>
          <button type="button" className="secondary" onClick={onClose}>
            취소
          </button>
          <button type="submit" disabled={saving}>
            <Send size={14} /> {saving ? '등록 중…' : '등록'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function DeliveryDrawer({
  delivery,
  onClose,
}: {
  delivery: WebhookDelivery & { attempts?: WebhookAttempt[] };
  onClose: () => void;
}) {
  return (
    <div className="webhook-drawer-backdrop" onMouseDown={onClose}>
      <aside
        className="webhook-drawer"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <StatusBadge status={delivery.status} />
            <h3>{eventLabel(delivery.event_type)}</h3>
          </div>
          <button onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <dl className="delivery-meta">
          <div>
            <dt>Event ID</dt>
            <dd>{delivery.event_key}</dd>
          </div>
          <div>
            <dt>Instance</dt>
            <dd>{delivery.instance_id}</dd>
          </div>
          <div>
            <dt>Endpoint</dt>
            <dd>{delivery.endpoint_name}</dd>
          </div>
          <div>
            <dt>마지막 HTTP</dt>
            <dd>{delivery.response_status || '—'}</dd>
          </div>
          <div>
            <dt>마지막 오류</dt>
            <dd>{delivery.last_error || '없음'}</dd>
          </div>
        </dl>
        <section>
          <h4>전송 시도</h4>
          <div className="attempt-list">
            {(delivery.attempts || []).map((attempt) => (
              <article key={attempt.id}>
                <StatusBadge status={attempt.status} />
                <div>
                  <strong>#{attempt.attempt_number}</strong>
                  <span>
                    HTTP {attempt.response_status || '—'} ·{' '}
                    {attempt.duration_ms}ms
                  </span>
                  {attempt.duplicate && <small>중복 수신 응답(409)</small>}
                  {attempt.error && <small>{attempt.error}</small>}
                </div>
                <time>{formatDate(attempt.started_at)}</time>
              </article>
            ))}
            {!delivery.attempts?.length && (
              <div className="webhook-empty">아직 전송 시도가 없습니다.</div>
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}

function StatusBadge({ status }: { status: WebhookDeliveryStatus }) {
  const Icon =
    status === 'SENT'
      ? CheckCircle2
      : status === 'DEAD_LETTER'
        ? AlertTriangle
        : status === 'CANCELED'
          ? CircleOff
          : Clock3;
  return (
    <span className={`webhook-status ${status.toLowerCase()}`}>
      <Icon size={12} />
      {STATUS_LABELS[status]}
    </span>
  );
}

function eventLabel(value: string) {
  if (value.endsWith('_APPROVED')) return '최종 승인';
  if (value.endsWith('_REJECTED')) return '최종 반려';
  if (value.endsWith('_CANCELED')) return '최종 취소';
  return value;
}

function shortId(value: string) {
  return value.length > 18
    ? `${value.slice(0, 8)}…${value.slice(-6)}`
    : value;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function errorText(value: unknown) {
  return value instanceof Error ? value.message : '요청을 처리하지 못했습니다.';
}
