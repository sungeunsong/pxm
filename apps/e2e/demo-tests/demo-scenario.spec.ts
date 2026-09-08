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
      await ui.page.getByRole('button', { name: '워크플로우 관리', exact: true }).click();
      const row = ui.page.getByRole('row').filter({ hasText: '실습 2 · 협력사 접근 권한 신청' });
      await expect(row).toBeVisible();
      await row.click();
      await expect(ui.page.getByLabel('워크플로우 작성 이력')).toBeVisible();
      await expect(ui.page.locator('.workflow-detail-panel')).toContainText('Versionv1');
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
    await ui.context.close();
  });
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

function rectanglesOverlap(
  first: { left: number; right: number; top: number; bottom: number },
  second: { left: number; right: number; top: number; bottom: number },
) {
  return first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
}
