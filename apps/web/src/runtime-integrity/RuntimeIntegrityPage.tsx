import { useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, RefreshCw, ShieldCheck, Stethoscope, Wrench } from 'lucide-react';
import {
  runtimeIntegrityApi,
  type RuntimeIntegrityFinding,
  type RuntimeIntegrityFindingType,
  type RuntimeIntegrityScan,
} from '../api/runtime-integrity';
import './RuntimeIntegrityPage.css';

const TYPE_LABELS: Record<RuntimeIntegrityFindingType, string> = {
  ORPHAN_JOB: '연결 없는 작업',
  ORPHAN_TOKEN: '연결 없는 토큰',
  ORPHAN_TASK: '연결 없는 승인',
  STALLED_INSTANCE: '멈춘 실행',
  WAITING_APPROVAL_WITHOUT_TASK: '승인 작업 누락',
  INSTANCE_MISSING_DEFINITION: '워크플로우 정의 누락',
};

export function RuntimeIntegrityPage() {
  const [scan, setScan] = useState<RuntimeIntegrityScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [repairingId, setRepairingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const runScan = async () => {
    setScanning(true);
    setError('');
    try {
      setScan(await runtimeIntegrityApi.scan());
    } catch (value) {
      setError(errorText(value));
    } finally {
      setScanning(false);
    }
  };

  const repair = async (finding: RuntimeIntegrityFinding) => {
    if (!finding.repair.supported) return;
    const reason = window.prompt(
      `${finding.title}\n\n복구 전에 현재 상태를 다시 확인합니다. 처리 사유를 입력해 주세요.`,
      '',
    )?.trim();
    if (!reason) return;
    if (reason.length < 3) {
      setError('복구 사유를 3자 이상 입력해 주세요.');
      return;
    }
    if (!window.confirm(`"${finding.repair.label}" 작업을 실행할까요?\n\n대상: ${finding.resource_id}`)) return;

    setRepairingId(finding.id);
    setError('');
    setMessage('');
    try {
      const result = await runtimeIntegrityApi.repair(finding, reason);
      setMessage(result.message);
      setScan(await runtimeIntegrityApi.scan());
    } catch (value) {
      setError(errorText(value));
    } finally {
      setRepairingId(null);
    }
  };

  const manualCount = scan ? scan.total - scan.repairable : 0;

  return <div className="runtime-integrity-page">
    <section className="integrity-intro">
      <div>
        <span className="integrity-eyebrow"><ShieldCheck size={15} /> 최고관리자 전용</span>
        <h2>워크플로우 실행 이상 점검</h2>
        <p>실행 정보 사이의 연결이 끊겼거나 처리 작업 없이 멈춘 항목을 찾습니다. 점검만으로 데이터가 변경되지는 않습니다.</p>
      </div>
      <button className="integrity-scan-button" onClick={() => void runScan()} disabled={scanning}>
        <RefreshCw size={16} className={scanning ? 'spin' : ''} />
        {scanning ? '점검 중…' : scan ? '다시 점검' : '지금 점검'}
      </button>
    </section>

    {message && <div className="integrity-message success"><CheckCircle2 size={17} />{message}</div>}
    {error && <div className="integrity-message error"><AlertTriangle size={17} />{error}</div>}

    {!scan ? <section className="integrity-empty">
      <Stethoscope size={38} />
      <h3>아직 점검하지 않았습니다</h3>
      <p>버튼을 누르면 60초 이상 상태 변화가 없는 실행 데이터만 검사합니다.</p>
    </section> : <>
      <section className="integrity-summary">
        <article><span>발견된 이상</span><strong>{scan.total}</strong><small>총 점검 결과</small></article>
        <article className="repairable"><span>안전한 복구 가능</span><strong>{scan.repairable}</strong><small>관리자 확인 후 처리</small></article>
        <article className="manual"><span>원인 확인 필요</span><strong>{manualCount}</strong><small>자동 변경하지 않음</small></article>
        <article><span>마지막 점검</span><strong className="date">{formatDate(scan.scanned_at)}</strong><small>기준: 60초 이상</small></article>
      </section>

      {scan.findings.length === 0 ? <section className="integrity-empty healthy">
        <CheckCircle2 size={38} />
        <h3>발견된 이상이 없습니다</h3>
        <p>현재 확인 가능한 실행 데이터의 연결 상태가 정상입니다.</p>
      </section> : <section className="integrity-results">
        <header>
          <div><h3>점검 결과</h3><p>복구 버튼을 누르면 처리 직전에 상태를 다시 확인합니다.</p></div>
          <span>{scan.findings.length}개</span>
        </header>
        <div className="integrity-list">
          {scan.findings.map((finding) => <article key={finding.id} className={finding.repair.supported ? 'repairable' : 'manual'}>
            <div className="integrity-finding-icon">
              {finding.repair.supported ? <Wrench size={19} /> : <CircleHelp size={19} />}
            </div>
            <div className="integrity-finding-main">
              <div className="integrity-finding-title">
                <strong>{finding.title}</strong>
                <span>{TYPE_LABELS[finding.type]}</span>
              </div>
              <p>{finding.description}</p>
              <dl>
                <div><dt>대상</dt><dd>{finding.resource_type} · {shortId(finding.resource_id)}</dd></div>
                {finding.instance_id && <div><dt>실행 ID</dt><dd>{shortId(finding.instance_id)}</dd></div>}
                <div><dt>마지막 변경</dt><dd>{formatDate(finding.observed_updated_at)}</dd></div>
              </dl>
            </div>
            <div className="integrity-finding-action">
              {finding.repair.supported
                ? <button onClick={() => void repair(finding)} disabled={repairingId !== null}>
                    {repairingId === finding.id ? '재확인 중…' : finding.repair.label}
                  </button>
                : <span><CircleHelp size={14} /> 수동 확인 필요</span>}
            </div>
          </article>)}
        </div>
      </section>}
    </>}
  </div>;
}

function shortId(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
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
