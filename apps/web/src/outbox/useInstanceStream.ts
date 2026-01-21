import { useEffect, useRef, useState } from 'react';

export type StreamEvent = {
  id: string;
  event: string;
  data: any;
};

export function useInstanceStream(instanceId: string) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const lastIdRef = useRef<string>('0');
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!instanceId) return;

    // EventSource는 자동 재연결을 해주고,
    // 브라우저가 Last-Event-ID를 내부적으로 관리해주는 경우가 많지만
    // 프록시/환경 따라 삐끗할 수 있어 "가장 단순"하게 먼저 붙여봄.
    const url = `/instances/${encodeURIComponent(instanceId)}/stream`;
    const es = new EventSource(url);
    esRef.current = es;

    const push = (event: MessageEvent, eventName: string) => {
      const id = (event as any).lastEventId || '';
      if (id) lastIdRef.current = id;

      let data: any = event.data;
      try { data = JSON.parse(event.data); } catch {}
      setEvents((prev) => [...prev, { id: id || '0', event: eventName, data }]);
    };

    // 기본 message
    es.onmessage = (e) => push(e, 'message');

    // outbox에서 event_type을 event명으로 쏘고 있으니, 대표 타입을 리스닝
    const types = ['INSTANCE_RUNNING','NODE_STARTED','NODE_COMPLETED','NODE_FAILED','TASK_CREATED','TASK_COMPLETED','ping','error'];
    const handlers: Array<[string, (e: MessageEvent) => void]> = [];

    for (const t of types) {
      const h = (e: MessageEvent) => push(e, t);
      es.addEventListener(t, h);
      handlers.push([t, h]);
    }

    es.onerror = () => {
      // EventSource가 알아서 재연결 시도함
      // 여기서 UI에 'reconnecting...' 같은 표시만 해줘도 UX가 좋아짐
    };

    return () => {
      for (const [t, h] of handlers) es.removeEventListener(t, h);
      es.close();
      esRef.current = null;
    };
  }, [instanceId]);

  return { events };
}
