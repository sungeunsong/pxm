import { useInstanceStream } from './outbox/useInstanceStream';

export function StreamPanel({ instanceId }: { instanceId: string }) {
  const { events } = useInstanceStream(instanceId);

  return (
    <div style={{ padding: 12 }}>
      <h3>Stream: {instanceId}</h3>
      <div style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
        {events.slice(-200).map((e, i) => (
          <div key={i}>
            [{e.id}] {e.event} {typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}
          </div>
        ))}
      </div>
    </div>
  );
}
