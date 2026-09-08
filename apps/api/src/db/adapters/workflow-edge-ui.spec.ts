import { restorePostgresUiEdge } from './postgres.adapter';

describe('PostgreSQL workflow edge UI metadata', () => {
  it('restores business labels, default markers, and approval handles', () => {
    const gatewayEdge = restorePostgresUiEdge({
      id: 'database-edge-id',
      source_node_id: 'gateway',
      target_node_id: 'approval',
      condition_expr: '',
      is_default: true,
      metadata: {
        ui_edge: {
          id: 'gateway-review',
          source: 'stale-source',
          target: 'stale-target',
          type: 'conditionEdge',
          label: '검토 필요',
          data: { label: '검토 필요', isDefault: false },
        },
      },
    });
    const approvalEdge = restorePostgresUiEdge({
      id: 'approval-approved',
      source_node_id: 'approval',
      target_node_id: 'end',
      condition_expr: 'approved',
      is_default: false,
      metadata: {
        ui_edge: {
          id: 'approval-approved',
          source: 'approval',
          sourceHandle: 'approved',
          target: 'end',
          type: 'conditionEdge',
        },
      },
    });

    expect(gatewayEdge).toEqual(expect.objectContaining({
      id: 'gateway-review',
      source: 'gateway',
      target: 'approval',
      label: '검토 필요',
      type: 'conditionEdge',
      data: expect.objectContaining({ label: '검토 필요', isDefault: true }),
    }));
    expect(approvalEdge).toEqual(expect.objectContaining({
      id: 'approval-approved',
      sourceHandle: 'approved',
      type: 'conditionEdge',
      data: expect.objectContaining({ condition: 'approved', isDefault: false }),
    }));
  });
});
