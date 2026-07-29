import { BadRequestException } from '@nestjs/common';
import {
  externalApprovalKeyHash,
  externalApprovalRequestHash,
  dynamicApprovalRequestPath,
  normalizeExternalApprovalRequest,
} from '../instances/external-approval-start';

describe('external approval workflow start', () => {
  it('normalizes the provider namespace and defaults revision to one', () => {
    const formData = {
      approval_request: {
        source: 'acrapoint',
        request_id: ' AP-42 ',
        content: { title: '휴가 결재' },
      },
    };

    expect(normalizeExternalApprovalRequest(formData)).toEqual({
      provider: 'acrapoint',
      requestId: 'AP-42',
      revision: 1,
    });
    expect(formData.approval_request).toMatchObject({
      source: { provider: 'acrapoint' },
      request_id: 'AP-42',
      revision: 1,
    });
  });

  it('keeps the same subject independent across provider namespaces', () => {
    const first = {
      approval_request: { source: { provider: 'acrapoint' }, request_id: '100', revision: 2 },
    };
    const second = {
      approval_request: { source: { provider: 'another-erp' }, request_id: '100', revision: 2 },
    };

    expect(normalizeExternalApprovalRequest(first)).not.toEqual(normalizeExternalApprovalRequest(second));
  });

  it('uses a stable payload hash and separates provider and revision namespaces', () => {
    const left = {
      approval_request: {
        source: { provider: 'acrapoint' },
        request_id: 'AP-42',
        revision: 1,
        content: { title: '결재', summary: '내용' },
      },
    };
    const reordered = {
      approval_request: {
        content: { summary: '내용', title: '결재' },
        revision: 1,
        request_id: 'AP-42',
        source: { provider: 'acrapoint' },
      },
    };

    expect(externalApprovalRequestHash('workflow-1', left)).toBe(
      externalApprovalRequestHash('workflow-1', reordered),
    );
    expect(externalApprovalKeyHash({ provider: 'acrapoint', requestId: 'AP-42', revision: 1 })).not.toBe(
      externalApprovalKeyHash({ provider: 'another-erp', requestId: 'AP-42', revision: 1 }),
    );
    expect(externalApprovalKeyHash({ provider: 'acrapoint', requestId: 'AP-42', revision: 1 })).not.toBe(
      externalApprovalKeyHash({ provider: 'acrapoint', requestId: 'AP-42', revision: 2 }),
    );
  });

  it('normalizes a custom request path configured by the approval node', () => {
    const nodes = [
      {
        data: {
          nodeType: 'approval',
          approvalLineSource: 'dynamic',
          approvalRequestPath: 'purchase.approval',
        },
      },
    ];
    const formData = {
      purchase: {
        approval: { source: 'erp', request_id: 'PO-7' },
      },
    };
    const path = dynamicApprovalRequestPath(nodes);

    expect(normalizeExternalApprovalRequest(formData, path)).toEqual({
      provider: 'erp',
      requestId: 'PO-7',
      revision: 1,
    });
    expect(formData.purchase.approval.source).toEqual({ provider: 'erp' });
  });

  it.each([
    { source: {}, request_id: 'AP-1' },
    { source: { provider: 'bad provider' }, request_id: 'AP-1' },
    { source: 'acrapoint', request_id: '' },
    { source: 'acrapoint', request_id: 'AP-1', revision: 0 },
    { source: 'acrapoint', request_id: 'AP-1', revision: 1.5 },
  ])('rejects an invalid external request key: %p', (approvalRequest) => {
    expect(() => normalizeExternalApprovalRequest({ approval_request: approvalRequest })).toThrow(BadRequestException);
  });
});
