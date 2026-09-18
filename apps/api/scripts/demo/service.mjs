import http from 'node:http';
const port = Number(process.env.PXM_DEMO_SERVICE_PORT || 3020);
http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && req.url === '/health') return send(200, { service: 'pxm-guided-demo', ok: true });
  if (req.method !== 'POST' || !['/invoke', '/webhook'].includes(req.url)) return send(404, { error: 'not found' });
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 262144) return send(413, { error: 'body too large' }); }
    const input = JSON.parse(body);
    if (req.url === '/webhook') {
      console.log(`데모 결과 Webhook 수신: ${input.event_type || 'unknown'} / ${input.data?.approval_request_id || input.id || '-'}`);
      return send(200, { accepted: true, simulated: true });
    }
    if (!input.emp_id || !['read', 'admin'].includes(input.privilege_level) || !input.target_system) return send(400, { error: 'invalid grant request' });
    send(200, { simulated: true, granted: true, ...input });
  } catch { send(400, { error: 'invalid JSON' }); }
}).listen(port, '127.0.0.1', () => console.log(`데모 전용 모의 권한 반영: http://127.0.0.1:${port}`));
