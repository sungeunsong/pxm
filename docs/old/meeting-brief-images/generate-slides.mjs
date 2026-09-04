import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('docs/meeting-brief-images');
const width = 1600;
const height = 900;

const slides = [
  {
    title: 'PXM/BPM 플랫폼 구조',
    subtitle: 'Workflow runtime과 외부 시스템 연동을 분리한 BPM Core',
    bullets: [
      'BPM Web에서 프로세스를 설계하고 실행한다.',
      'API/BFF가 템플릿, 인스턴스, Task, Plugin Registry를 관리한다.',
      'Engine은 workflow runtime 실행에 집중한다.',
      '외부 시스템 연동은 Engine에 하드코딩하지 않고 plugin으로 확장한다.',
      'DB는 adapter 구조로 MongoDB 우선, PostgreSQL 확장 가능하게 설계했다.',
    ],
    diagram: ['BPM Web', 'API / BFF', 'DB Adapter', 'MongoDB 우선', 'Engine', 'Plugin Host'],
  },
  {
    title: '두 가지 사용 방식',
    subtitle: '제품형 Web 사용과 플랫폼형 API 호출을 모두 지원',
    columns: [
      {
        heading: 'PXM Web 사용',
        items: [
          '사용자가 Web에 로그인',
          '관리자가 template 설계',
          '요청자가 workflow 실행',
          '승인자가 결재함에서 승인/반려',
          '운영자가 trace와 실행 이력 확인',
        ],
      },
      {
        heading: '외부 솔루션 API 호출',
        items: [
          '사내 포털, ITSM, HR 등에서 API 호출',
          'PXM Web 없이 workflow runtime 사용',
          '기존 업무 시스템에서 Task 조회/처리 가능',
          'BPM backend platform 역할',
        ],
      },
    ],
  },
  {
    title: '인증과 접근 제어',
    subtitle: '사람이 쓰는 인증과 시스템이 호출하는 인증을 분리',
    columns: [
      {
        heading: 'User Authentication',
        items: [
          'Session 또는 JWT 기반 로그인',
          'SSO / LDAP / AD / OAuth / OIDC 확장',
          'role / permission',
          'workspace 또는 tenant 접근 제어',
          '설계, 실행, 승인, 운영 권한 분리',
        ],
      },
      {
        heading: 'Machine-to-Machine',
        items: [
          'API Key',
          'Client ID / Client Secret',
          'OAuth2 Client Credentials',
          'mTLS / IP allowlist',
          'service account 기반 API 권한',
        ],
      },
    ],
  },
  {
    title: 'BPM 실행 흐름',
    subtitle: 'Start -> Approval -> Service Plugin -> End',
    steps: [
      'Web에서 workflow template 설계',
      'API가 template 저장 및 instance 생성',
      'Engine이 job polling 후 token 실행',
      'Approval node에서 task 생성 후 대기',
      '승인 완료 시 resume job 처리',
      'Service node에서 plugin_id 기반 executor 호출',
      '모든 node 완료 시 instance COMPLETED',
    ],
  },
  {
    title: 'DB Adapter와 Mongo 우선 전략',
    subtitle: 'Runtime data를 특정 DB 구현에 고정하지 않는 구조',
    bullets: [
      'workflow instance, context, form data, execution log는 JSON 성격이 강하다.',
      'MongoDB는 초기 runtime 검증과 유연한 context 저장에 적합하다.',
      'API와 Engine은 DB adapter/port를 통해 runtime data를 다룬다.',
      'PostgreSQL adapter도 확장 가능한 구조로 유지한다.',
    ],
    tags: [
      'v2_process_definitions',
      'v2_process_instances',
      'v2_tokens',
      'v2_tasks',
      'v2_engine_jobs',
      'v2_event_outbox',
      'v2_execution_logs',
      'v2_advisory_locks',
    ],
  },
  {
    title: '플러그인 방식으로 바꾼 이유',
    subtitle: 'Engine 수정 없이 업무 connector를 확장하기 위해',
    columns: [
      {
        heading: '기존 하드코딩 방식의 문제',
        items: [
          'Slack/Jira/ACRA/NIT 연동이 Engine 코드에 섞임',
          '새 연동 추가 시 Engine 수정 필요',
          'Engine 배포가 잦아짐',
          '고객사별 connector 차이를 흡수하기 어려움',
        ],
      },
      {
        heading: 'Plugin 구조의 장점',
        items: [
          'Engine은 plugin_id만 알고 실행',
          '업무 의미는 plugin-host 또는 external service가 담당',
          'manifest와 executor 등록으로 신규 연동 추가',
          'runtime과 업무 연동 책임 분리',
        ],
      },
    ],
  },
  {
    title: 'Plugin Registry와 Web Palette',
    subtitle: 'Manifest 기반으로 Web node와 실행 계약을 제공',
    bullets: [
      'Plugin Registry는 plugin_id, version, category, schema, executor 정보를 가진다.',
      'Web은 manifest를 보고 plugin palette와 node 설정 form을 렌더링한다.',
      'Slack, NIT, ACRA, Jira, HR, AD 같은 연동이 1급 노드처럼 보인다.',
      '저장되는 runtime shape은 node_type = service, plugin_id = connector.* 이다.',
    ],
    tags: [
      'connector.slack.send_message',
      'connector.nit.create_issue',
      'connector.acra.grant_permission',
      'connector.jira.create_issue',
      'connector.hr.lookup_user',
      'connector.ad.grant_group',
      'builtin.http_request',
    ],
  },
  {
    title: 'Plugin Executor 유형',
    subtitle: '연동 특성에 따라 실행 방식을 분리',
    columns: [
      {
        heading: 'builtin / mock',
        items: [
          'builtin: Engine 내부 generic executor',
          '예: builtin.http_request',
          '업무 connector는 builtin에 넣지 않음',
          'mock: 개발 및 테스트용 executor',
        ],
      },
      {
        heading: 'hosted / external_http',
        items: [
          'hosted: pxm-plugin-host에서 공식/고객사 connector 실행',
          'on-prem 기본 모델에 적합',
          'external_http: 별도 HTTP service로 격리 실행',
          '무거운 연동 또는 별도 runtime이 필요한 경우 적합',
        ],
      },
    ],
  },
  {
    title: '운영 통제와 테스트 결과',
    subtitle: '운영 환경을 위한 enable/disable, allowlist, audit, resource limit',
    columns: [
      {
        heading: '운영 통제',
        items: [
          'plugin enable / disable',
          'version pinning',
          'workspace/customer allowlist',
          'trusted source 검사',
          'install/control/execute audit log',
          'isolation policy와 resource limits',
        ],
      },
      {
        heading: '확인한 테스트',
        items: [
          'pnpm build: pass',
          'db:mongo:check: pass',
          'smoke:mongo:approval: pass',
          'smoke:mongo:gateway: pass',
          'hosted plugin conformance: pass',
          'external_http conformance: pass',
        ],
      },
    ],
  },
  {
    title: '회의에서 결정할 항목',
    subtitle: '제품화 전에 정책 결정이 필요한 부분',
    bullets: [
      'Web 사용자 인증을 SSO/OIDC/LDAP/AD 중 어디까지 지원할지',
      '외부 API 인증을 API Key, OAuth2 Client Credentials, mTLS 중 무엇으로 시작할지',
      '고객사별 plugin 배포를 hosted 중심으로 할지 external_http를 얼마나 허용할지',
      'Plugin Registry를 파일 기반으로 유지할지 DB-backed registry로 확장할지',
      'Secret store를 환경변수/file에서 Vault/KMS 계열로 확장할지',
      'Plugin signature 검증을 cryptographic signature까지 강화할지',
      'UI에서 plugin install/control 화면을 제공할지',
    ],
    quote: 'PXM/BPM Core는 workflow runtime에 집중하고, 외부 시스템 연동은 plugin registry와 plugin-host를 통해 확장한다.',
  },
];

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function textBlock(lines, x, y, options = {}) {
  const size = options.size || 34;
  const color = options.color || '#0f172a';
  const weight = options.weight || 600;
  const gap = options.gap || size * 1.35;
  return lines
    .map((line, index) => `<text x="${x}" y="${y + index * gap}" font-size="${size}" font-weight="${weight}" fill="${color}">${esc(line)}</text>`)
    .join('\n');
}

function bulletList(items, x, y, maxChars = 52, color = '#1e293b') {
  let cursor = y;
  const out = [];
  for (const item of items) {
    const lines = wrapText(item, maxChars);
    out.push(`<circle cx="${x}" cy="${cursor - 10}" r="6" fill="#2563eb"/>`);
    out.push(textBlock(lines, x + 24, cursor, { size: 29, color, weight: 600, gap: 39 }));
    cursor += lines.length * 39 + 20;
  }
  return out.join('\n');
}

function card(x, y, w, h, title, items) {
  return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="#ffffff" stroke="#dbe4f0"/>
  <text x="${x + 34}" y="${y + 58}" font-size="34" font-weight="800" fill="#1d4ed8">${esc(title)}</text>
  ${bulletList(items, x + 40, y + 116, Math.floor(w / 18), '#334155')}
  `;
}

function tagCloud(tags, x, y, maxWidth) {
  let cursorX = x;
  let cursorY = y;
  const out = [];
  for (const tag of tags) {
    const w = Math.max(180, tag.length * 17 + 42);
    if (cursorX + w > x + maxWidth) {
      cursorX = x;
      cursorY += 62;
    }
    out.push(`<rect x="${cursorX}" y="${cursorY}" width="${w}" height="42" rx="10" fill="#eff6ff" stroke="#bfdbfe"/>`);
    out.push(`<text x="${cursorX + 20}" y="${cursorY + 28}" font-size="22" font-weight="700" fill="#1e40af">${esc(tag)}</text>`);
    cursorX += w + 16;
  }
  return out.join('\n');
}

function diagram(nodes) {
  const startX = 140;
  const y = 690;
  const boxW = 190;
  const gap = 38;
  return nodes
    .map((node, index) => {
      const x = startX + index * (boxW + gap);
      const arrow = index < nodes.length - 1
        ? `<path d="M ${x + boxW + 8} ${y + 45} L ${x + boxW + gap - 12} ${y + 45}" stroke="#64748b" stroke-width="4" marker-end="url(#arrow)"/>`
        : '';
      return `
        <rect x="${x}" y="${y}" width="${boxW}" height="90" rx="16" fill="#f8fafc" stroke="#cbd5e1"/>
        <text x="${x + boxW / 2}" y="${y + 55}" text-anchor="middle" font-size="22" font-weight="800" fill="#0f172a">${esc(node)}</text>
        ${arrow}
      `;
    })
    .join('\n');
}

function steps(items) {
  const x = 140;
  let y = 230;
  return items
    .map((item, index) => {
      const lines = wrapText(item, 54);
      const block = `
        <circle cx="${x + 28}" cy="${y - 10}" r="26" fill="#2563eb"/>
        <text x="${x + 28}" y="${y}" text-anchor="middle" font-size="24" font-weight="900" fill="#ffffff">${index + 1}</text>
        ${textBlock(lines, x + 78, y, { size: 31, color: '#1e293b', weight: 700, gap: 42 })}
      `;
      y += Math.max(76, lines.length * 42 + 24);
      return block;
    })
    .join('\n');
}

function renderSlide(slide, index) {
  const body = [];
  if (slide.bullets) body.push(bulletList(slide.bullets, 130, 250, 66));
  if (slide.columns) {
    body.push(card(120, 240, 690, 460, slide.columns[0].heading, slide.columns[0].items));
    body.push(card(850, 240, 690, 460, slide.columns[1].heading, slide.columns[1].items));
  }
  if (slide.steps) body.push(steps(slide.steps));
  if (slide.tags) body.push(tagCloud(slide.tags, 130, slide.bullets ? 610 : 250, 1340));
  if (slide.diagram) body.push(diagram(slide.diagram));
  if (slide.quote) {
    body.push(`
      <rect x="130" y="705" width="1340" height="92" rx="18" fill="#0f172a"/>
      ${textBlock(wrapText(slide.quote, 64), 170, 758, { size: 28, color: '#ffffff', weight: 800, gap: 36 })}
    `);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#64748b"/>
    </marker>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f8fafc"/>
      <stop offset="1" stop-color="#eef4ff"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#bg)"/>
  <rect x="42" y="38" width="1516" height="824" rx="30" fill="#ffffff" stroke="#dbe4f0"/>
  <text x="96" y="112" font-size="24" font-weight="800" fill="#2563eb">PXM BPM PLATFORM</text>
  <text x="96" y="184" font-size="54" font-weight="900" fill="#0f172a">${esc(slide.title)}</text>
  <text x="98" y="229" font-size="28" font-weight="600" fill="#64748b">${esc(slide.subtitle)}</text>
  ${body.join('\n')}
  <text x="1460" y="820" font-size="22" font-weight="800" fill="#94a3b8">${String(index + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}</text>
</svg>`;
}

fs.mkdirSync(outDir, { recursive: true });

const links = [];
slides.forEach((slide, index) => {
  const fileName = `slide-${String(index + 1).padStart(2, '0')}.svg`;
  fs.writeFileSync(path.join(outDir, fileName), renderSlide(slide, index));
  links.push({ fileName, title: slide.title });
});

const indexHtml = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>BPM/PXM 플랫폼 설명 이미지</title>
  <style>
    body { margin: 0; padding: 32px; background: #e2e8f0; font-family: system-ui, sans-serif; }
    h1 { margin: 0 0 24px; color: #0f172a; }
    .slide { margin: 0 0 32px; background: white; border-radius: 16px; box-shadow: 0 12px 24px rgba(15, 23, 42, .12); overflow: hidden; }
    .slide img { display: block; width: 100%; height: auto; }
    .caption { padding: 12px 16px; font-weight: 800; color: #334155; }
  </style>
</head>
<body>
  <h1>BPM/PXM 플랫폼 설명 이미지</h1>
  ${links.map((link, i) => `
    <section class="slide">
      <img src="./${link.fileName}" alt="${esc(link.title)}" />
      <div class="caption">${i + 1}. ${esc(link.title)} - ${link.fileName}</div>
    </section>
  `).join('')}
</body>
</html>`;

fs.writeFileSync(path.join(outDir, 'index.html'), indexHtml);
console.log(`Generated ${slides.length} slides in ${outDir}`);
