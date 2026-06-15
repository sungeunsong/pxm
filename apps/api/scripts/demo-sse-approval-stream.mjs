#!/usr/bin/env node
const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3000/api';
const autoApproveDelayMs = Number(process.env.AUTO_APPROVE_DELAY_MS || 1200);
const timeoutMs = Number(process.env.SSE_DEMO_TIMEOUT_MS || 30000);

async function main() {
  const template = await postJson(`${apiBaseUrl}/templates`, {
    name: `SSE Demo Approval ${new Date().toISOString()}`,
    nodes: [
      node('start', 'start', 'Start', 0),
      node('approval', 'approval', 'Manager Approval', 220, {
        assignee: 'admin',
      }),
      node('svc', 'service', 'HTTP Notice', 440, {
        plugin_id: 'builtin.http_request',
        method: 'GET',
        url: `${apiBaseUrl}/debug/flaky?key=sse-demo&fail=0`,
      }),
      node('end', 'end', 'End', 660),
    ],
    edges: [
      edge('e-start-approval', 'start', 'approval'),
      edge('e-approval-svc', 'approval', 'svc'),
      edge('e-svc-end', 'svc', 'end'),
    ],
  });

  const execution = await postJson(`${apiBaseUrl}/templates/${template.id}/execute`, {
    formData: {
      requester: 'sse-demo',
      purpose: 'watch-event-stream',
    },
  });

  const instanceId = execution.instance_id;
  if (!instanceId) {
    throw new Error('execute response must include instance_id');
  }

  console.log(`[sse-demo] template=${template.id}`);
  console.log(`[sse-demo] instance=${instanceId}`);
  console.log(`[sse-demo] stream=${apiBaseUrl}/instances/${instanceId}/stream`);
  console.log('[sse-demo] waiting for events...');

  let approvedTaskId = null;
  let completed = false;

  await consumeSse(`${apiBaseUrl}/instances/${instanceId}/stream`, async (event) => {
    const type = event.data?.type || event.event || 'message';
    const nodeId = event.data?.node_id || event.data?.payload?.node_id || '-';
    const source = event.data?.source || 'sse';
    const payload = event.data?.payload || {};

    console.log(
      `[sse] #${event.id || '-'} ${type.padEnd(20)} source=${source.padEnd(13)} node=${String(nodeId).padEnd(10)} payload=${JSON.stringify(payload)}`,
    );

    if (type === 'TASK_CREATED' && payload.task_id && !approvedTaskId) {
      approvedTaskId = payload.task_id;
      console.log(`[sse-demo] auto-approve task=${approvedTaskId} after ${autoApproveDelayMs}ms`);
      setTimeout(async () => {
        try {
          await postJson(`${apiBaseUrl}/tasks/${approvedTaskId}/complete`, {
            action: 'approve',
          });
          console.log(`[sse-demo] approved task=${approvedTaskId}`);
        } catch (error) {
          console.error(`[sse-demo] approve failed: ${error.message}`);
        }
      }, autoApproveDelayMs);
    }

    if (type === 'INSTANCE_COMPLETED') {
      completed = true;
      return false;
    }

    return true;
  }, timeoutMs);

  if (!completed) {
    throw new Error(`Timed out before INSTANCE_COMPLETED for ${instanceId}`);
  }

  const trace = await getJson(`${apiBaseUrl}/instances/${instanceId}/trace`);
  console.log(`[sse-demo] completed instance=${instanceId} trace_events=${trace.length}`);
}

function node(id, nodeType, label, x, extraData = {}) {
  return {
    id,
    type: 'custom',
    position: { x, y: 0 },
    data: { label, nodeType, ...extraData },
  };
}

function edge(id, source, target) {
  return { id, source, target };
}

async function consumeSse(url, onEvent, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'text/event-stream',
      },
    });
    if (!response.ok || !response.body) {
      throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\n\n/);
      buffer = chunks.pop() || '';

      for (const chunk of chunks) {
        const event = parseSseChunk(chunk);
        if (!event.data) continue;
        const keepGoing = await onEvent(event);
        if (!keepGoing) {
          controller.abort();
          return;
        }
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
}

function parseSseChunk(chunk) {
  const event = {};
  const dataLines = [];

  for (const line of chunk.split(/\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const key = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).trimStart() : '';

    if (key === 'event') {
      event.event = value;
    } else if (key === 'id') {
      event.id = value;
    } else if (key === 'data') {
      dataLines.push(value);
    }
  }

  if (dataLines.length > 0) {
    const text = dataLines.join('\n');
    try {
      event.data = JSON.parse(text);
    } catch {
      event.data = text;
    }
  }

  return event;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
}

main().catch((error) => {
  console.error('[sse-demo] failed');
  console.error(error);
  process.exitCode = 1;
});
