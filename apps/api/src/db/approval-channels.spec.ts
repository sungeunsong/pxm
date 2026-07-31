import {
  allowsApprovalChannel,
  approvalChannels,
  primaryApprovalChannel,
} from './approval-channels';

describe('approvalChannels', () => {
  it('keeps legacy singular channel inputs compatible', () => {
    expect(approvalChannels({ approver_channel: 'external_email' })).toEqual([
      'external_email',
    ]);
    expect(approvalChannels({})).toEqual(['pxm_user']);
  });

  it('normalizes a hybrid channel list without creating duplicate channels', () => {
    const payload = {
      approval_channels: ['external_email', 'pxm_user', 'external_email'],
      approver_channel: 'external_email',
    };
    expect(approvalChannels(payload)).toEqual([
      'external_email',
      'pxm_user',
    ]);
    expect(allowsApprovalChannel(payload, 'pxm_user')).toBe(true);
    expect(allowsApprovalChannel(payload, 'external_email')).toBe(true);
    expect(primaryApprovalChannel(payload)).toBe('pxm_user');
  });
});
