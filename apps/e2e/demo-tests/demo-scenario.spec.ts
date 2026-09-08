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
