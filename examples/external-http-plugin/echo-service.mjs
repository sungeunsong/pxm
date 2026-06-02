#!/usr/bin/env node
import http from 'node:http';

const port = Number(process.env.PORT ?? 3020);

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { status: 'ok' });
  }

  if (req.method !== 'POST' || req.url !== '/invoke') {
    return sendJson(res, 404, {
      success: false,
      retryable: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Use POST /invoke',
      },
    });
  }

  try {
    const request = JSON.parse(await readBody(req));
    return sendJson(res, 200, {
      success: true,
      output: {
        connector: 'external_echo',
        plugin_id: request.plugin_id,
        message: request.config?.message ?? null,
        instance_id: request.instance?.id ?? null,
        node_id: request.node?.id ?? null,
        attempt: request.attempt ?? 0,
      },
    });
  } catch (error) {
    return sendJson(res, 400, {
      success: false,
      retryable: false,
      error: {
        code: 'BAD_REQUEST',
        message: error instanceof Error ? error.message : 'Invalid request',
      },
    });
  }
});

server.listen(port, () => {
  console.log(`External echo plugin listening on http://127.0.0.1:${port}`);
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body || '{}'));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'application/json',
  });
  res.end(JSON.stringify(body));
}
