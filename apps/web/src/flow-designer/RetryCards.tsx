import React from 'react';
import { AlertCircle, Clock, XCircle } from 'lucide-react';

interface RetryInfo {
  attempt: number;
  max_attempts: number;
  next_delay_ms?: number;
  next_run_at?: string;
  will_retry: boolean;
  reason: string;
}

interface RetryCardProps {
  retryInfo: RetryInfo;
  timestamp: string;
  nodeLabel?: string;
  payload: any;
}

export const RetryScheduledCard: React.FC<RetryCardProps> = ({ retryInfo, timestamp, nodeLabel, payload }) => {
  const nextRetryTime = retryInfo.next_run_at 
    ? new Date(retryInfo.next_run_at).toLocaleTimeString('ko-KR')
    : `${Math.round((retryInfo.next_delay_ms || 0) / 1000)}초 후`;

  return (
    <div className="timeline-event event-retry_scheduled retry-card">
      <div className="timeline-event-marker">
        <Clock size={16} className="status-icon warning" />
      </div>
      <div className="timeline-event-content">
        <div className="timeline-event-header">
          <span className="timeline-event-type">재시도 예약됨</span>
          <span className="timeline-event-time">
            {new Date(timestamp).toLocaleTimeString('ko-KR')}
          </span>
        </div>
        
        {/* Retry 정보 카드 */}
        <div className="retry-info-card">
          <div className="retry-info-row">
            <span className="retry-info-label">시도 횟수</span>
            <span className="retry-info-value">
              <strong>{retryInfo.attempt}</strong> / {retryInfo.max_attempts}
            </span>
          </div>
          <div className="retry-info-row">
            <span className="retry-info-label">다음 시도</span>
            <span className="retry-info-value">{nextRetryTime}</span>
          </div>
          <div className="retry-info-row">
            <span className="retry-info-label">실패 이유</span>
            <span className="retry-info-value retry-reason">{retryInfo.reason}</span>
          </div>
        </div>
        
        {nodeLabel && (
          <div className="timeline-event-detail">
            노드: <strong>{nodeLabel}</strong>
          </div>
        )}
        
        <details className="timeline-event-payload">
          <summary>상세 정보 보기</summary>
          <pre>{JSON.stringify(payload, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
};

interface FailureCardProps {
  retryInfo: RetryInfo;
  timestamp: string;
  nodeLabel?: string;
  payload: any;
  isFinal: boolean;
  statusCode?: number;
}

export const NodeFailedCard: React.FC<FailureCardProps> = ({ 
  retryInfo, 
  timestamp, 
  nodeLabel, 
  payload, 
  isFinal,
  statusCode 
}) => {
  return (
    <div className={`timeline-event event-node_failed ${isFinal ? 'final-failure' : 'retry-failure'}`}>
      <div className="timeline-event-marker">
        {isFinal ? (
          <XCircle size={16} className="status-icon error" />
        ) : (
          <AlertCircle size={16} className="status-icon error" />
        )}
      </div>
      <div className="timeline-event-content">
        <div className="timeline-event-header">
          <span className="timeline-event-type">
            {isFinal ? '최종 실패' : '노드 실패'}
          </span>
          <span className="timeline-event-time">
            {new Date(timestamp).toLocaleTimeString('ko-KR')}
          </span>
        </div>
        
        {/* 실패 정보 카드 */}
        <div className={`failure-info-card ${isFinal ? 'final' : ''}`}>
          {isFinal && (
            <div className="final-failure-banner">
              ⚠️ 최대 재시도 횟수를 초과했습니다
            </div>
          )}
          <div className="retry-info-row">
            <span className="retry-info-label">시도 횟수</span>
            <span className="retry-info-value">
              <strong>{retryInfo.attempt}</strong> / {retryInfo.max_attempts}
            </span>
          </div>
          <div className="retry-info-row">
            <span className="retry-info-label">실패 이유</span>
            <span className="retry-info-value retry-reason">{retryInfo.reason}</span>
          </div>
          {statusCode && (
            <div className="retry-info-row">
              <span className="retry-info-label">HTTP 상태</span>
              <span className="retry-info-value">{statusCode}</span>
            </div>
          )}
          {!isFinal && (
            <div className="retry-info-row">
              <span className="retry-info-label">재시도 여부</span>
              <span className="retry-info-value success-text">✓ 재시도 예정</span>
            </div>
          )}
        </div>
        
        {nodeLabel && (
          <div className="timeline-event-detail">
            노드: <strong>{nodeLabel}</strong>
          </div>
        )}
        
        <details className="timeline-event-payload">
          <summary>에러 상세 정보</summary>
          <pre>{JSON.stringify(payload, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
};
