import { expect, test } from '@playwright/test';
import { loginPage } from '../tests/support';

test('사용 기록 없는 그룹의 영구 삭제 방식을 화면에서 명확히 안내한다', async ({ browser }) => {
  const groupName = `삭제 정책 확인 ${Date.now()}`;
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'access');

  await ui.page.getByPlaceholder('그룹 이름').fill(groupName);
  await ui.page.getByPlaceholder('설명').fill('사용 기록 없는 임시 그룹');
  await ui.page.getByRole('button', { name: '저장', exact: true }).click();

  const row = ui.page.locator('.access-list-row').filter({ hasText: groupName });
  await expect(row).toBeVisible();
  await row.click();
  await ui.page.getByRole('button', { name: '삭제 영향 확인', exact: true }).click();

  await expect(ui.page.locator('.group-deletion-impact')).toContainText('영구 삭제가 적용됩니다');
  await expect(ui.page.locator('.group-deletion-impact')).toContainText('복구할 수 없습니다');
  await ui.page.getByRole('button', { name: '사용 기록 없는 그룹 영구 삭제', exact: true }).click();
  await ui.page.getByRole('button', { name: '영구 삭제', exact: true }).click();

  await expect(ui.page.getByText(groupName, { exact: true })).toHaveCount(0);
  await ui.page.getByRole('button', { name: /^삭제됨 \d+$/ }).click();
  await expect(ui.page.getByText(groupName, { exact: true })).toHaveCount(0);
  await ui.context.close();
});

test('사용 이력이 있는 그룹은 복구 가능한 삭제와 후속 확인을 안내한다', async ({ browser }) => {
  const groupName = `복구 정책 확인 ${Date.now()}`;
  const serviceAccountName = `복구 확인 계정 ${Date.now()}`;
  const ui = await loginPage(browser, 'admin', process.env.PXM_DEMO_PASSWORD!, 'access');

  await ui.page.getByPlaceholder('그룹 이름').fill(groupName);
  await ui.page.getByPlaceholder('설명').fill('복구 가능한 삭제 확인 그룹');
  await ui.page.getByRole('button', { name: '저장', exact: true }).click();
  const groupRow = ui.page.locator('.access-list-row').filter({ hasText: groupName });
  await expect(groupRow).toBeVisible();
  await groupRow.click();

  await ui.page.getByRole('button', { name: /^서비스 계정/ }).click();
  const serviceAccountForm = ui.page.locator('form').filter({ has: ui.page.getByPlaceholder('서비스 계정 ID') });
  await serviceAccountForm.getByPlaceholder('이름', { exact: true }).fill(serviceAccountName);
  await serviceAccountForm.getByRole('button', { name: '저장', exact: true }).click();
  await expect(ui.page.getByText(serviceAccountName, { exact: true })).toBeVisible();

  await ui.page.getByRole('button', { name: '삭제 영향 확인', exact: true }).click();
  const impact = ui.page.locator('.group-deletion-impact');
  await expect(impact).toContainText('복구 가능한 삭제가 적용됩니다');
  await expect(impact).toContainText('서비스 계정 이력 1건');
  await impact.getByRole('button', { name: '복구 가능한 삭제', exact: true }).click();
  await ui.page.getByRole('dialog').getByRole('button', { name: '복구 가능한 삭제', exact: true }).click();

  await ui.page.getByRole('button', { name: /^삭제됨 \d+$/ }).click();
  const deletedRow = ui.page.locator('.access-list-row').filter({ hasText: groupName });
  await expect(deletedRow).toBeVisible();
  await deletedRow.click();
  await ui.page.getByRole('button', { name: '복구', exact: true }).click();

  await expect(ui.page.locator('.group-recovery-guide')).toContainText('복구 후 확인이 필요합니다');
  await expect(ui.page.locator('.group-recovery-guide')).toContainText('새 키를 발급');
  await ui.page.getByRole('button', { name: '복구 확인 완료', exact: true }).click();
  await expect(ui.page.locator('.group-recovery-guide')).toHaveCount(0);
  await ui.context.close();
});
