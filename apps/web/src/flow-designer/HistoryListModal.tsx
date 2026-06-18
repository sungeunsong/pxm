import React, { useEffect, useState } from 'react';
import { X, Clock, CheckCircle, AlertCircle, Loader, Copy } from 'lucide-react';
import './HistoryListModal.css';

interface Instance {
  id: string;
  template_id: string;
  template_name: string;
  status: 'CREATED' | 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED';
  created_at: string;
}

interface HistoryListModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (instanceId: string) => void;
}

export const HistoryListModal: React.FC<HistoryListModalProps> = ({
  isOpen,
  onClose,
  onSelect,
}) => {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      fetchInstances();
    }
  }, [isOpen]);

  const fetchInstances = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/instances');
      if (!res.ok) throw new Error('Failed to fetch instances');
      const data = await res.json();
      setInstances(data);
    } catch (error) {
      console.error('Failed to fetch instances:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <CheckCircle size={14} className="status-icon success" />;
      case 'FAILED':
        return <AlertCircle size={14} className="status-icon error" />;
      case 'RUNNING':
      case 'WAITING':
        return <Loader size={14} className="status-icon running" />;
      default:
        return <div className="status-dot" />;
    }
  };

  const formatTime = (iso: string) => {
    return new Date(iso).toLocaleString('ko-KR', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleCopyId = async (event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    await navigator.clipboard.writeText(id);
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content history-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="header-title-wrapper">
            <Clock size={20} />
            <h2 className="modal-title">실행 이력</h2>
          </div>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          {loading ? (
            <div className="loading-state">
              <Loader className="spinning" />
              <span>불러오는 중...</span>
            </div>
          ) : instances.length === 0 ? (
            <div className="empty-state">
              <p>실행 내역이 없습니다.</p>
            </div>
          ) : (
            <div className="instance-list">
              {instances.map((inst) => (
                <div 
                  key={inst.id} 
                  className="instance-item"
                  onClick={() => onSelect(inst.id)}
                >
                  <div className="instance-info">
                    <span className="instance-name">{inst.template_name || '이름 없음'}</span>
                    <span className="instance-id-row">
                      <span className="instance-id">{inst.id}</span>
                      <button
                        type="button"
                        className="history-id-copy-button"
                        onClick={(event) => handleCopyId(event, inst.id)}
                        title="Instance ID 복사"
                        aria-label="Instance ID 복사"
                      >
                        <Copy size={13} />
                      </button>
                    </span>
                  </div>
                  <div className="instance-meta">
                    <span className={`status-badge status-${inst.status.toLowerCase()}`}>
                      {getStatusIcon(inst.status)}
                      {inst.status}
                    </span>
                    <span className="instance-time">{formatTime(inst.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
