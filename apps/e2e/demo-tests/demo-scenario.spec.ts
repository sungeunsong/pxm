import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { loginPage } from '../tests/support';

test('발표 시연 경로: 관리 설정 확인부터 신청자 자동 처리까지', async ({ browser }) => {
  const access = JSON.parse(await readFile(process.env.PXM_DEMO_ACCESS_FILE!, 'utf8'));

  await test.step('장면 1 · 그룹과 사용자 권한 확인', async () => {
    const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'access');
    await expect(ui.page.getByText('데모 · 보안운영팀', { exact: true })).toBeVisible();
    await expect(ui.page.locator('.access-alert.error')).toHaveCount(0);

    await test.step('장면 2 · 자격증명 원문 비노출 확인', async () => {
      await ui.page.getByRole('button', { name: '연동 자격증명', exact: true }).click();
      await expect(ui.page.getByText('데모 · 직원 DB', { exact: true })).toBeVisible();
      await expect(ui.page.getByText('데모 · 권한 반영 API', { exact: true })).toBeVisible();
      await expect(ui.page.getByText(/pxm_live_/)).toHaveCount(0);
    });

    await test.step('장면 3~4 · 플러그인과 배포된 워크플로우 확인', async () => {
      await ui.page.getByRole('button', { name: '플러그인 제어', exact: true }).click();
      await expect(ui.page.locator('main')).toContainText('builtin.http_request');
      await ui.page.getByRole('button', { name: '명령어 관리', exact: true }).click();
      await expect(ui.page.locator('main')).toContainText('demo.request_summary');
      await expect(ui.page.locator('main')).toContainText('demo.path_label');
      await ui.page.getByRole('button', { name: '워크플로우 관리', exact: true }).click();
      const row = ui.page.getByRole('row').filter({ hasText: '실습 2 · 협력사 접근 권한 신청' });
      await expect(row).toBeVisible();
      await expect(ui.page.getByRole('row').filter({ hasText: '실습 8 · Node.js 버전 점검 분기' })).toBeVisible();
      await row.click();
      await expect(ui.page.getByLabel('워크플로우 작성 이력')).toBeVisible();
      await expect(ui.page.locator('.workflow-detail-panel')).toContainText(/Versionv\d+/);
      await expect(ui.page.getByRole('button', { name: '즉시 실행', exact: true })).toBeVisible();
    });

    await test.step('장면 7 · 실행 이상 점검 화면 확인', async () => {
      await ui.page.getByRole('button', { name: '실행 이상 점검', exact: true }).click();
      await expect(ui.page.locator('main')).not.toContainText('불러오지 못했습니다');
    });
    await ui.context.close();
  });

  await test.step('장면 5 · 신청자가 프리셋으로 저위험 요청 실행', async () => {
    const ui = await loginPage(browser, 'demo-requester1', access.accounts['demo-requester1'], 'request');
    const row = ui.page.getByRole('row').filter({ hasText: '실습 2 · 협력사 접근 권한 신청' });
    await expect(row).toBeVisible();
    await row.click();
    await ui.page.getByRole('button', { name: '저위험 · 자동 처리', exact: true }).click();
    await expect(ui.page.locator('.form-group').filter({ hasText: '사번' }).locator('input')).toHaveValue('E-1001');
    await expect(ui.page.locator('.form-group').filter({ hasText: '권한 (read / admin)' }).locator('input')).toHaveValue('read');
    await ui.page.getByRole('button', { name: '요청 제출', exact: true }).click();
    await expect(ui.page).toHaveURL(/#\/my-requests$/);
    await expect(ui.page.locator('main')).toContainText('실습 2 · 협력사 접근 권한 신청');

    await test.step('장면 6 · 결재 없는 JS 라이브러리 실행 결과 확인', async () => {
      await ui.page.getByRole('button', { name: '요청하기', exact: true }).click();
      const libraryRow = ui.page.getByRole('row').filter({ hasText: '실습 4 · 승인된 JS 라이브러리 사용' });
      await expect(libraryRow).toBeVisible();
      await libraryRow.click();
      await ui.page.getByRole('button', { name: 'lodash 숫자 집계', exact: true }).click();
      await ui.page.getByRole('button', { name: '요청 제출', exact: true }).click();
      await expect(ui.page).toHaveURL(/#\/my-requests$/);
      await expect(ui.page.locator('.request-progress-card')).toContainText('워크플로우 실행이 완료되었습니다');
      await expect(ui.page.locator('.request-progress-card')).not.toContainText('결재 진행 중');
      await expect(ui.page.locator('.request-summary-card').filter({ hasText: '실행 결과' })).toContainText('"total":68');
    });
    await ui.context.close();
  });
});

test('그룹 관리자는 목록 중심 화면에서 API Key 발급 범위를 단계별로 확인한다', async ({ browser }) => {
  const access = JSON.parse(await readFile(process.env.PXM_DEMO_ACCESS_FILE!, 'utf8'));
  const ui = await loginPage(browser, 'demo-secadmin', access.accounts['demo-secadmin'], 'access');

  await expect(ui.page.getByRole('button', { name: '새 그룹', exact: true })).toHaveCount(0);
  await expect(ui.page.getByRole('button', { name: '삭제 영향 확인', exact: true })).toHaveCount(0);

  await ui.page.getByRole('button', { name: '사이드바 접기', exact: true }).click();
  await ui.page.getByRole('button', { name: '사용자 및 권한', exact: true }).hover();
  await expect(ui.page.getByRole('tooltip', { name: '사용자 및 권한', exact: true })).toBeVisible();
  await ui.page.getByRole('button', { name: '사이드바 펼치기', exact: true }).click();

  await ui.page.getByRole('button', { name: /^API Key/ }).click();
  await expect(ui.page.getByText('데모 · API 실행 키', { exact: true })).toBeVisible();
  await expect(ui.page.getByText('데모 · API 결재 키', { exact: true })).toBeVisible();

  await ui.page.getByRole('button', { name: 'API Key 발급', exact: true }).click();
  const drawer = ui.page.getByRole('dialog', { name: 'API Key 발급' });
  await expect(drawer.getByText('누가 사용할 키인가요?', { exact: true })).toBeVisible();
  await drawer.getByLabel(/Key 이름/).fill('UI 검증용 키');
  await drawer.getByRole('button', { name: '다음', exact: true }).click();
  await expect(drawer.getByText('무엇을 할 수 있나요?', { exact: true })).toBeVisible();
  await expect(drawer.getByText('결재 승인·반려', { exact: true })).toBeVisible();
  await drawer.getByRole('checkbox', { name: /실습 1 · 기본 접근 권한 결재/ }).check();
  await drawer.getByRole('button', { name: '다음', exact: true }).click();
  await expect(drawer.getByText('보안 제한을 확인하세요', { exact: true })).toBeVisible();
  await expect(drawer.locator('.key-review')).toContainText('서비스 계정');
  await drawer.getByRole('button', { name: '상세 패널 닫기' }).click();
  await expect(ui.page.locator('.pxm-drawer-backdrop')).toHaveClass(/is-closing/);
  await expect(drawer).toBeHidden();

  await ui.page.locator('.access-page-tabs').getByRole('button', { name: /사용자 관리/ }).click();
  await ui.page.getByRole('button', { name: '새 사용자 추가', exact: true }).click();
  const userDrawer = ui.page.getByRole('dialog', { name: '새 사용자 계정' });
  await expect(userDrawer).toContainText('기존 계정을 그룹에 추가하려는 경우');
  await userDrawer.getByRole('button', { name: '상세 패널 닫기' }).click();
  await ui.context.close();
});

test('워크플로우 운영 기능은 관리 화면에 모으고 불러오기는 선택에 집중한다', async ({ browser }) => {
  const access = JSON.parse(await readFile(process.env.PXM_DEMO_ACCESS_FILE!, 'utf8'));
  const ui = await loginPage(browser, 'demo-secadmin', access.accounts['demo-secadmin'], 'access');

  await ui.page.getByRole('button', { name: '워크플로우 관리', exact: true }).click();
  await ui.page.getByRole('row').filter({ hasText: '실습 5 · 디자이너와 배포 수명주기' }).click();
  const management = ui.page.locator('.workflow-management-section');
  await expect(management).toContainText('워크플로우 관리');
  await expect(management.getByRole('button', { name: '배포 중지', exact: true })).toBeVisible();
  await expect(management.getByRole('button', { name: '메타데이터 수정', exact: true })).toBeVisible();
  await expect(management.getByRole('button', { name: '버전 이력', exact: true })).toBeVisible();
  await expect(management.getByRole('button', { name: '파일로 내보내기', exact: true })).toBeVisible();

  await management.getByRole('button', { name: '메타데이터 수정', exact: true }).click();
  const metadataDrawer = ui.page.getByRole('dialog', { name: '워크플로우 메타데이터 수정' });
  await expect(metadataDrawer.locator('input').first()).toHaveValue('실습 5 · 디자이너와 배포 수명주기');
  await expect(metadataDrawer.getByText('저장 후 Version Note와 Export 파일에 기록됩니다.')).toBeVisible();
  const drawerBox = await metadataDrawer.boundingBox();
  const formBox = await metadataDrawer.locator('.workflow-metadata-form').boundingBox();
  expect(drawerBox).not.toBeNull();
  expect(formBox).not.toBeNull();
  expect(formBox!.x - drawerBox!.x).toBeGreaterThanOrEqual(20);
  expect(drawerBox!.x + drawerBox!.width - (formBox!.x + formBox!.width)).toBeGreaterThanOrEqual(20);
  await metadataDrawer.locator('textarea').last().fill('E2E 메타데이터 관리 검증');
  await metadataDrawer.getByRole('button', { name: '새 버전으로 저장', exact: true }).click();
  await expect(metadataDrawer).toBeHidden();
  const publishButton = management.getByRole('button', { name: /^v\d+ 배포$/ });
  await expect(publishButton).toBeVisible();
  await publishButton.click();
  const publishDialog = ui.page.getByRole('dialog', { name: /배포할까요/ });
  await publishDialog.getByRole('button', { name: '배포', exact: true }).click();
  await expect(management.getByRole('button', { name: '배포 중지', exact: true })).toBeVisible();

  await management.getByRole('button', { name: '버전 이력', exact: true }).click();
  const versionDrawer = ui.page.getByRole('dialog', { name: '워크플로우 버전 이력' });
  await expect(versionDrawer).toContainText(/현재 v\d+/);
  await expect(versionDrawer.getByRole('button', { name: '비교', exact: true }).first()).toBeVisible();
  await versionDrawer.getByRole('button', { name: '상세 패널 닫기' }).click();
  await expect(versionDrawer).toBeHidden();

  await ui.page.getByRole('button', { name: '워크플로우 설계', exact: true }).click();
  await ui.page.getByRole('button', { name: '더 보기' }).click();
  await ui.page.getByRole('menuitem', { name: '불러오기', exact: true }).click();
  const loadCard = ui.page.getByRole('listitem').filter({ hasText: '실습 5 · 디자이너와 배포 수명주기' });
  await expect(loadCard.getByRole('button', { name: '불러오기', exact: true })).toBeVisible();
  await expect(loadCard).toContainText('수정');
  await expect(loadCard).toContainText('demo-secadmin');
  await expect(loadCard).toContainText('생성');
  await expect(loadCard).toContainText('admin');
  await expect(loadCard.getByRole('button', { name: '배포', exact: true })).toHaveCount(0);
  await expect(loadCard.getByRole('button', { name: '배포 중지', exact: true })).toHaveCount(0);
  await expect(loadCard.getByRole('button', { name: '버전', exact: true })).toHaveCount(0);
  await expect(loadCard.getByRole('button', { name: '삭제', exact: true })).toHaveCount(0);

  await ui.context.close();
});

test('배율이 변경된 워크플로우 캔버스에서 노드를 마우스 위치에 드롭한다', async ({ browser }) => {
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'designer');
  await ui.page.getByRole('button', { name: '노드 팔레트 펼치기' }).click();

  const canvas = ui.page.locator('.react-flow');
  await expect(canvas).toBeVisible();
  await ui.page.locator('.react-flow__controls-zoomout').click();
  await ui.page.locator('.react-flow__controls-zoomout').click();

  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  const targetPosition = {
    x: Math.round(canvasBox!.width * 0.55),
    y: Math.round(canvasBox!.height * 0.5),
  };
  await ui.page.locator('.palette-node[title^="Timer"]').dragTo(canvas, { targetPosition });

  const timerNode = canvas.locator('.react-flow__node').filter({ hasText: 'Timer' }).last();
  await expect(timerNode).toBeVisible();
  const nodeBox = await timerNode.boundingBox();
  expect(nodeBox).not.toBeNull();
  expect(Math.abs(nodeBox!.x - (canvasBox!.x + targetPosition.x))).toBeLessThan(12);
  expect(Math.abs(nodeBox!.y - (canvasBox!.y + targetPosition.y))).toBeLessThan(12);
  await ui.context.close();
});

test('분기 업무 라벨과 승인 결과를 엣지 중앙에서 구분한다', async ({ browser }) => {
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'designer');
  await ui.page.getByRole('button', { name: '더 보기' }).click();
  await ui.page.getByRole('menuitem', { name: '불러오기' }).click();
  await ui.page.locator('.template-info').filter({ hasText: '실습 2 · 협력사 접근 권한 신청' }).click();

  const labels = ui.page.getByTestId('branch-edge-label');
  await expect(labels.filter({ hasText: '저위험' })).toHaveCount(1);
  await expect(labels.filter({ hasText: '검토 필요' })).toHaveCount(1);
  await expect(labels.filter({ hasText: '승인' })).toHaveCount(2);
  await expect(labels.filter({ hasText: '반려' })).toHaveCount(2);
  await expect(labels.filter({ hasText: '검토 필요' }).getByText('기본', { exact: true })).toBeVisible();
  await expect(ui.page.locator('.gateway-handle-label')).toHaveCount(0);

  const nodeBoxes = await ui.page.locator('.react-flow__node').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }),
  );
  const labelBoxes = await labels.evaluateAll((items) =>
    items.map((item) => {
      const box = item.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }),
  );
  for (const label of labelBoxes) {
    expect(nodeBoxes.some((node) => rectanglesOverlap(label, node))).toBe(false);
  }

  await ui.context.close();
});

test('디자이너 더보기 메뉴가 탭과 캔버스 위에서 모두 클릭 가능하다', async ({ browser }) => {
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'designer');
  await ui.page.getByRole('button', { name: '더 보기' }).click();

  const menu = ui.page.locator('.designer-overflow-menu');
  const tabBar = ui.page.locator('.workflow-tab-bar');
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  const tabBox = await tabBar.boundingBox();
  expect(menuBox).not.toBeNull();
  expect(tabBox).not.toBeNull();
  expect(menuBox!.y + menuBox!.height).toBeGreaterThan(tabBox!.y + tabBox!.height);

  const menuItems = menu.getByRole('menuitem');
  await expect(menuItems).toHaveCount(6);
  await expect(menu.getByRole('menuitem', { name: '자동 정렬' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '파일로 내보내기' })).toHaveCount(0);
  for (let index = 0; index < await menuItems.count(); index += 1) {
    const item = menuItems.nth(index);
    const clickable = await item.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const topElement = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return topElement === button || (topElement !== null && button.contains(topElement));
    });
    expect(clickable).toBe(true);
  }

  await ui.page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await ui.context.close();
});

test('자동 정렬을 캔버스 메뉴에서 되돌리고 탭을 바꾸면 스냅샷을 폐기한다', async ({ browser }) => {
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'designer');
  await openWorkflowFromDesigner(ui.page, '실습 2 · 협력사 접근 권한 신청');

  const before = await readNodeTransforms(ui.page);
  await ui.page.getByRole('button', { name: '더 보기' }).click();
  await ui.page.getByRole('menuitem', { name: '자동 정렬', exact: true }).click();
  await expect(ui.page.getByText(/노드 \d+개를 다시 배치했습니다/)).toBeVisible();
  await expect.poll(() => readNodeTransforms(ui.page)).not.toEqual(before);

  const pane = ui.page.locator('.react-flow__pane');
  const paneBox = await pane.boundingBox();
  expect(paneBox).not.toBeNull();
  const menuPosition = { x: Math.round(paneBox!.width * 0.5), y: Math.round(paneBox!.height * 0.85) };
  await pane.click({ button: 'right', position: menuPosition });
  const canvasMenu = ui.page.getByRole('menu', { name: '캔버스' });
  await canvasMenu.getByRole('menuitem', { name: '자동 정렬 되돌리기' }).click();
  await expect.poll(() => readNodeTransforms(ui.page)).toEqual(before);

  await ui.page.getByRole('button', { name: '더 보기' }).click();
  await ui.page.getByRole('menuitem', { name: '자동 정렬', exact: true }).click();
  await ui.page.getByRole('button', { name: '새 워크플로우 탭' }).click();
  await pane.click({ button: 'right', position: menuPosition });
  await expect(ui.page.getByRole('menu', { name: '캔버스' }).getByRole('menuitem', { name: '자동 정렬 되돌리기' })).toHaveCount(0);

  await ui.context.close();
});

test('손대지 않은 빈 탭만 불러온 워크플로우로 교체한다', async ({ browser }) => {
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'designer');
  const tabs = ui.page.locator('.workflow-tab');

  await expect(tabs).toHaveCount(1);
  await expect(ui.page.getByRole('tab', { name: '새 워크플로우', exact: true })).toBeVisible();

  await openWorkflowFromDesigner(ui.page, '실습 2 · 협력사 접근 권한 신청');
  await expect(tabs).toHaveCount(1);
  await expect(ui.page.getByRole('tab', { name: /실습 2 · 협력사 접근 권한 신청/ })).toBeVisible();
  await expect(ui.page.getByRole('tab', { name: '새 워크플로우', exact: true })).toHaveCount(0);

  await ui.page.getByRole('button', { name: '새 워크플로우 탭' }).click();
  await expect(tabs).toHaveCount(2);
  await expect(ui.page.getByRole('tab', { name: '새 워크플로우', exact: true })).toBeVisible();

  await openWorkflowFromDesigner(ui.page, '실습 1 · 기본 접근 권한 결재');
  await expect(tabs).toHaveCount(2);
  await expect(ui.page.getByRole('tab', { name: /실습 1 · 기본 접근 권한 결재/ })).toBeVisible();
  await expect(ui.page.getByRole('tab', { name: '새 워크플로우', exact: true })).toHaveCount(0);

  await ui.page.getByRole('button', { name: '새 워크플로우 탭' }).click();
  await addTimerFromCanvasMenu(ui.page);
  await openWorkflowFromDesigner(ui.page, '실습 2 · 협력사 접근 권한 신청');
  await expect(tabs).toHaveCount(3);
  await expect(ui.page.getByRole('tab', { name: '새 워크플로우', exact: true })).toBeVisible();

  await addTimerFromCanvasMenu(ui.page);
  await ui.page.getByRole('button', { name: '더 보기' }).click();
  await ui.page.getByRole('menuitem', { name: '불러오기' }).click();
  await ui.page.locator('.template-info').filter({ hasText: '실습 2 · 협력사 접근 권한 신청' }).click();
  const discardDialog = ui.page.getByRole('dialog', { name: '저장하지 않은 변경사항이 있습니다' });
  await expect(discardDialog).toContainText('저장된 버전을 다시 불러오면 현재 변경사항이 사라집니다.');
  await discardDialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(ui.page.getByRole('heading', { name: '템플릿 불러오기' })).toBeVisible();
  await expect(ui.page.locator('.react-flow__node').filter({ hasText: 'Timer' })).toHaveCount(1);

  await ui.context.close();
});

test('미니맵에서 노드 유형 색상과 현재 뷰포트를 구분한다', async ({ browser }) => {
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'designer');
  await openWorkflowFromDesigner(ui.page, '실습 2 · 협력사 접근 권한 신청');

  const minimap = ui.page.locator('.flow-minimap');
  const minimapNodes = minimap.locator('.react-flow__minimap-node');
  await expect(minimap).toBeVisible();
  await expect(minimapNodes).toHaveCount(9);

  const nodeFills = await minimapNodes.evaluateAll((nodes) =>
    nodes.map((node) => getComputedStyle(node).fill),
  );
  expect(new Set(nodeFills).size).toBeGreaterThanOrEqual(6);
  expect(nodeFills).toContain('rgb(16, 185, 129)');
  expect(nodeFills).toContain('rgb(59, 130, 246)');
  expect(nodeFills).toContain('rgb(236, 72, 153)');
  expect(nodeFills).toContain('rgb(239, 68, 68)');
  expect(nodeFills).not.toContain('rgb(241, 245, 249)');

  const mask = minimap.locator('.react-flow__minimap-mask');
  await expect(mask).toHaveCSS('fill', 'rgba(15, 23, 42, 0.14)');
  await expect(mask).toHaveCSS('fill-opacity', '1');

  await ui.context.close();
});

test('실행 이력은 노드 상태와 실제 경로를 저장 변경 없이 표시한다', async ({ browser }) => {
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'designer');
  await openWorkflowFromDesigner(ui.page, '실습 2 · 협력사 접근 권한 신청');

  await ui.page.getByRole('button', { name: '더 보기' }).click();
  await ui.page.getByRole('menuitem', { name: '실행 이력', exact: true }).click();
  const completedRun = ui.page.locator('.instance-item')
    .filter({ hasText: '실습 2 · 협력사 접근 권한 신청' })
    .filter({ hasText: 'COMPLETED' })
    .first();
  await expect(completedRun).toBeVisible();
  await completedRun.click();

  const legend = ui.page.getByLabel('노드 실행 상태 범례');
  await expect(legend).toBeVisible();
  await expect(legend).toContainText('실행 중대기완료실패미실행');
  await expect(ui.page.locator('.custom-node[data-execution-status="completed"]')).not.toHaveCount(0);

  const runtimeFills = await ui.page.locator('.flow-minimap .react-flow__minimap-node').evaluateAll((nodes) =>
    nodes.map((node) => getComputedStyle(node).fill),
  );
  expect(runtimeFills).toContain('rgb(22, 163, 74)');
  expect(runtimeFills).toContain('rgb(148, 163, 184)');

  const activeTab = ui.page.locator('.workflow-tab.active');
  await expect(activeTab.locator('.workflow-tab-status')).toHaveText('');
  await expect(activeTab.getByRole('tab')).not.toHaveAttribute('title', /저장 안 됨/);

  await ui.context.close();
});

test('실행 패널을 닫아도 캔버스 상태를 유지하고 명시적으로 지운다', async ({ browser }) => {
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'designer');
  await openWorkflowFromDesigner(ui.page, '실습 2 · 협력사 접근 권한 신청');

  await ui.page.getByRole('button', { name: '실행', exact: true }).click();
  const runForm = ui.page.locator('.execution-modal');
  await runForm.getByRole('button', { name: '저위험 · 자동 처리', exact: true }).click();
  await runForm.getByRole('button', { name: '제출', exact: true }).click();

  const executionPanel = ui.page.locator('.execution-panel');
  const legend = ui.page.getByLabel('노드 실행 상태 범례');
  await expect(executionPanel).toBeVisible();
  await expect(legend).toBeVisible();
  await expect(ui.page.locator('.custom-node[data-execution-status="completed"]')).toHaveCount(6);
  await expect(ui.page.locator('[data-testid="rf__edge-decision-provision"] path')).toHaveCSS('stroke', 'rgb(22, 163, 74)');
  await expect(ui.page.locator('[data-testid="rf__edge-decision-internal"] path')).toHaveCSS('stroke', 'rgb(148, 163, 184)');
  await expect(ui.page.locator('[data-testid="rf__edge-external-provision"] path')).toHaveCSS('stroke', 'rgb(148, 163, 184)');
  await expect(ui.page.locator('[data-testid="rf__edge-internal-rejected"] path')).toHaveCSS('stroke', 'rgb(148, 163, 184)');

  await executionPanel.locator('.execution-panel-close').click();
  await expect(executionPanel).toBeHidden();
  await expect(legend).toBeVisible();
  await expect(ui.page.locator('.custom-node[data-execution-status]')).not.toHaveCount(0);
  await expect(legend.getByRole('button', { name: '실행 상세', exact: true })).toBeVisible();

  await legend.getByRole('button', { name: '실행 표시 지우기', exact: true }).click();
  await expect(legend).toBeHidden();
  await expect(ui.page.locator('.custom-node[data-execution-status]')).toHaveCount(0);

  await ui.context.close();
});

test('캔버스 컨텍스트 메뉴로 마우스 위치에서 노드를 편집한다', async ({ browser }) => {
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'designer');
  const pane = ui.page.locator('.react-flow__pane');
  const wrapper = ui.page.locator('.flow-canvas-wrapper');
  const paneBox = await pane.boundingBox();
  expect(paneBox).not.toBeNull();
  const target = { x: Math.round(paneBox!.width * 0.72), y: Math.round(paneBox!.height * 0.2) };

  await pane.click({ button: 'right', position: target });
  let menu = ui.page.getByTestId('canvas-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '붙여넣기 Ctrl+V', exact: true })).toBeDisabled();
  await menu.getByRole('menuitem', { name: '노드 추가…', exact: true }).click();
  const quickAdd = ui.page.getByTestId('node-quick-add');
  await expect(quickAdd).toBeVisible();
  await quickAdd.getByRole('combobox', { name: '추가할 노드 검색' }).fill('Timer');
  await ui.page.keyboard.press('Enter');

  const timerNodes = wrapper.locator('.react-flow__node').filter({ hasText: 'Timer' });
  await expect(timerNodes).toHaveCount(1);
  const timer = timerNodes.first();
  const timerBox = await timer.boundingBox();
  expect(timerBox).not.toBeNull();
  expect(Math.abs(timerBox!.x - (paneBox!.x + target.x))).toBeLessThan(12);
  expect(Math.abs(timerBox!.y - (paneBox!.y + target.y))).toBeLessThan(12);

  await timer.click({ button: 'right' });
  menu = ui.page.getByTestId('canvas-context-menu');
  await expect(menu.getByRole('menuitem', { name: '속성 열기', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '복사 Ctrl+C', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '복제', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '삭제 Delete', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: '복제', exact: true }).click();
  await expect(timerNodes).toHaveCount(2);

  const copiedTimer = timerNodes.filter({ hasText: 'Timer copy' });
  await copiedTimer.focus();
  await ui.page.keyboard.press('Shift+F10');
  await expect(ui.page.getByTestId('canvas-context-menu')).toBeVisible();
  await ui.page.keyboard.press('Escape');
  await expect(ui.page.getByTestId('canvas-context-menu')).toBeHidden();

  await copiedTimer.click({ button: 'right', modifiers: ['Shift'] });
  await expect(ui.page.getByTestId('canvas-context-menu')).toBeHidden();

  await copiedTimer.click({ button: 'right' });
  await ui.page.getByTestId('canvas-context-menu').getByRole('menuitem', { name: '삭제 Delete', exact: true }).click();
  const dialog = ui.page.getByRole('dialog', { name: '이 노드를 삭제할까요?' });
  await expect(dialog).toContainText('연결된 엣지는 없습니다.');
  await dialog.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(timerNodes).toHaveCount(1);

  await pane.click({ button: 'right', position: { x: paneBox!.width - 200, y: 50 } });
  const edgeMenuBox = await ui.page.getByTestId('canvas-context-menu').boundingBox();
  const wrapperBox = await wrapper.boundingBox();
  expect(edgeMenuBox).not.toBeNull();
  expect(wrapperBox).not.toBeNull();
  expect(edgeMenuBox!.x).toBeGreaterThanOrEqual(wrapperBox!.x);
  expect(edgeMenuBox!.y).toBeGreaterThanOrEqual(wrapperBox!.y);
  expect(edgeMenuBox!.x + edgeMenuBox!.width).toBeLessThanOrEqual(wrapperBox!.x + wrapperBox!.width);
  expect(edgeMenuBox!.y + edgeMenuBox!.height).toBeLessThanOrEqual(wrapperBox!.y + wrapperBox!.height);
  await ui.context.close();
});

test('연결된 노드를 삭제하면 모든 입출력 엣지도 함께 삭제한다', async ({ browser }) => {
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'designer');
  await openWorkflowFromDesigner(ui.page, '실습 5 · 디자이너와 배포 수명주기');

  const approvalNode = ui.page.locator('.react-flow__node').filter({ hasText: '내부 담당자 승인' });
  await expect(approvalNode).toHaveCount(1);
  await expect(ui.page.locator('[data-testid="rf__edge-decision-approval"]')).toBeVisible();
  await expect(ui.page.locator('[data-testid="rf__edge-approval-provision"]')).toBeVisible();
  await expect(ui.page.locator('[data-testid="rf__edge-approval-rejected"]')).toBeVisible();

  await approvalNode.click({ button: 'right' });
  await ui.page.getByTestId('canvas-context-menu')
    .getByRole('menuitem', { name: '삭제 Delete', exact: true })
    .click();
  const dialog = ui.page.getByRole('dialog', { name: '이 노드를 삭제할까요?' });
  await expect(dialog).toContainText('연결된 엣지 3개도 함께 삭제됩니다.');
  await dialog.getByRole('button', { name: '삭제', exact: true }).click();

  await expect(approvalNode).toHaveCount(0);
  await expect(ui.page.locator('[data-testid="rf__edge-decision-approval"]')).toHaveCount(0);
  await expect(ui.page.locator('[data-testid="rf__edge-approval-provision"]')).toHaveCount(0);
  await expect(ui.page.locator('[data-testid="rf__edge-approval-rejected"]')).toHaveCount(0);
  await expect(ui.page.locator('[data-testid="rf__edge-provision-completed"]')).toBeVisible();

  await ui.context.close();
});

test('분기 엣지 컨텍스트 메뉴에서 설정과 삭제 동작을 구분한다', async ({ browser }) => {
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'designer');
  await ui.page.getByRole('button', { name: '더 보기' }).click();
  await ui.page.getByRole('menuitem', { name: '불러오기' }).click();
  await ui.page.locator('.template-info').filter({ hasText: '실습 2 · 협력사 접근 권한 신청' }).click();

  await dispatchContextMenu(ui.page.locator('[data-testid="rf__edge-decision-provision"]'));
  const gatewayMenu = ui.page.getByTestId('canvas-context-menu');
  await expect(gatewayMenu.getByRole('menuitem', { name: '사이에 노드 추가…' })).toBeVisible();
  await expect(gatewayMenu.getByRole('menuitem', { name: '분기 설정 열기' })).toBeVisible();
  await expect(gatewayMenu.getByRole('menuitem', { name: '연결 삭제' })).toBeVisible();
  await ui.page.keyboard.press('Escape');

  await dispatchContextMenu(ui.page.locator('[data-testid="rf__edge-internal-external"]'));
  const approvalMenu = ui.page.getByTestId('canvas-context-menu');
  await expect(approvalMenu.getByRole('menuitem', { name: '사이에 노드 추가…' })).toBeVisible();
  await expect(approvalMenu.getByRole('menuitem', { name: '결과 경로 확인' })).toBeVisible();
  await expect(approvalMenu.getByRole('menuitem', { name: '연결 삭제' })).toBeVisible();
  await ui.context.close();
});

test('빈 캔버스 더블클릭과 Tab으로 기본·플러그인 노드를 검색해 추가한다', async ({ browser }) => {
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'designer');
  const pane = ui.page.locator('.react-flow__pane');
  const viewport = ui.page.locator('.react-flow__viewport');
  const paneBox = await pane.boundingBox();
  expect(paneBox).not.toBeNull();
  const beforeTransform = await viewport.getAttribute('style');
  const position = { x: Math.round(paneBox!.width * 0.68), y: Math.round(paneBox!.height * 0.32) };

  await pane.dblclick({ position });
  const quickAdd = ui.page.getByTestId('node-quick-add');
  await expect(quickAdd).toBeVisible();
  await expect(viewport).toHaveAttribute('style', beforeTransform || '');
  await expect(quickAdd.getByRole('combobox', { name: '추가할 노드 검색' })).toBeFocused();
  await ui.page.keyboard.press('ArrowDown');
  await ui.page.keyboard.press('Enter');
  const timer = ui.page.locator('.react-flow__node').filter({ hasText: 'Timer' });
  await expect(timer).toHaveCount(1);

  await ui.page.locator('.flow-canvas-wrapper').focus();
  await ui.page.keyboard.press('Tab');
  await expect(quickAdd).toBeVisible();
  const results = quickAdd.locator('.node-quick-add-results');
  const beforeWheelTransform = await viewport.getAttribute('style');
  await results.hover();
  await ui.page.mouse.wheel(0, 240);
  await expect(quickAdd).toBeVisible();
  await expect(viewport).toHaveAttribute('style', beforeWheelTransform || '');
  expect(await results.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await quickAdd.getByRole('combobox').fill('http');
  const pluginOption = quickAdd.getByRole('option').filter({ hasText: 'HTTP Request' }).first();
  await expect(pluginOption).toContainText('Builtin · builtin');
  await ui.page.keyboard.press('Escape');
  await expect(quickAdd).toBeHidden();

  await timer.dblclick();
  await expect(quickAdd).toBeHidden();
  await ui.context.close();
});

test('그룹 관리자가 새 워크플로우를 자신의 관리 그룹에 저장한다', async ({ browser }) => {
  const access = JSON.parse(await readFile(process.env.PXM_DEMO_ACCESS_FILE!, 'utf8'));
  const ui = await loginPage(browser, 'demo-secadmin', access.accounts['demo-secadmin'], 'designer');

  await ui.page.getByRole('button', { name: '속성 패널 열기' }).click();
  await expect(ui.page.getByLabel('관리 그룹')).toHaveValue('pxm-guided-demo');
  await ui.page.getByRole('button', { name: '저장', exact: true }).click();
  const saveDialog = ui.page.getByRole('dialog', { name: '워크플로우 저장' });
  const workflowName = `E2E 신규 저장 ${Date.now()}`;
  await saveDialog.getByLabel('워크플로우 이름').fill(workflowName);
  await saveDialog.getByRole('button', { name: '저장', exact: true }).click();

  await expect(ui.page.locator('.pxm-toast-title', { hasText: '워크플로우를 저장했습니다.' })).toBeVisible();
  await expect(ui.page.getByRole('tab', { name: new RegExp(workflowName) })).toBeVisible();
  await ui.context.close();
});

test('저장하지 않은 설계는 이전 버전으로 실행하지 않는다', async ({ browser }) => {
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'designer');
  await openWorkflowFromDesigner(ui.page, '실습 7 · 명령 실행 터미널');
  await addTimerFromCanvasMenu(ui.page);

  await ui.page.getByRole('button', { name: '실행', exact: true }).click();
  await expect(ui.page.locator('.pxm-toast-title', { hasText: '변경사항을 먼저 저장해 주세요.' })).toBeVisible();
  await expect(ui.page.locator('.pxm-toast-description')).toContainText('마지막으로 저장된 버전');
  await expect(ui.page.locator('.execution-modal')).toHaveCount(0);
  await ui.context.close();
});

test('분기 엣지 사이에 노드를 넣어도 조건 라벨을 앞 연결에 유지한다', async ({ browser }) => {
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'designer');
  await openWorkflowFromDesigner(ui.page, '실습 2 · 협력사 접근 권한 신청');
  const nodes = ui.page.locator('.react-flow__node');
  const edges = ui.page.locator('.react-flow__edge');
  const beforeNodeCount = await nodes.count();
  const beforeEdgeCount = await edges.count();

  await dispatchContextMenu(ui.page.locator('[data-testid="rf__edge-decision-provision"]'));
  await ui.page.getByTestId('canvas-context-menu').getByRole('menuitem', { name: '사이에 노드 추가…' }).click();
  const quickAdd = ui.page.getByTestId('node-quick-add');
  await expect(quickAdd.getByRole('option').filter({ hasText: 'Start' })).toBeDisabled();
  await quickAdd.getByRole('combobox').fill('Timer');
  await ui.page.keyboard.press('Enter');

  await expect(nodes).toHaveCount(beforeNodeCount + 1);
  await expect(edges).toHaveCount(beforeEdgeCount + 1);
  await expect(ui.page.getByTestId('branch-edge-label').filter({ hasText: '저위험' })).toHaveCount(1);
  await expect(ui.page.locator('.react-flow__node').filter({ hasText: 'Timer' })).toHaveCount(1);
  await ui.context.close();
});

function rectanglesOverlap(
  first: { left: number; right: number; top: number; bottom: number },
  second: { left: number; right: number; top: number; bottom: number },
) {
  return first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
}

async function dispatchContextMenu(locator: import('@playwright/test').Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const viewport = locator.page().viewportSize();
  const clientX = viewport
    ? Math.max(1, Math.min(box!.x + box!.width / 2, viewport.width - 1))
    : box!.x + box!.width / 2;
  const clientY = viewport
    ? Math.max(1, Math.min(box!.y + box!.height / 2, viewport.height - 1))
    : box!.y + box!.height / 2;
  await locator.evaluate((element, point) => {
    element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: point.clientX,
      clientY: point.clientY,
    }));
  }, { clientX, clientY });
}

async function readNodeTransforms(page: import('@playwright/test').Page) {
  return page.locator('.react-flow__node').evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute('data-id'),
    transform: (node as HTMLElement).style.transform,
  })));
}

async function openWorkflowFromDesigner(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: '더 보기' }).click();
  await page.getByRole('menuitem', { name: '불러오기' }).click();
  await page.locator('.template-info').filter({ hasText: name }).click();
}

async function addTimerFromCanvasMenu(page: import('@playwright/test').Page) {
  const pane = page.locator('.react-flow__pane');
  const paneBox = await pane.boundingBox();
  expect(paneBox).not.toBeNull();
  await pane.click({
    button: 'right',
    position: { x: Math.round(paneBox!.width * 0.72), y: Math.round(paneBox!.height * 0.2) },
  });
  const menu = page.getByTestId('canvas-context-menu');
  await menu.getByRole('menuitem', { name: '노드 추가…', exact: true }).click();
  const quickAdd = page.getByTestId('node-quick-add');
  await quickAdd.getByRole('combobox').fill('Timer');
  await page.keyboard.press('Enter');
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Timer' })).toHaveCount(1);
}
