export type ApprovalChannel = 'pxm_user' | 'external_email';
export type ApprovalAuthenticationMethod =
  | 'pxm_session'
  | 'api_key'
  | 'email_link'
  | 'email_otp';

const SUPPORTED_CHANNELS = new Set<ApprovalChannel>([
  'pxm_user',
  'external_email',
]);

export function approvalChannels(payload: any): ApprovalChannel[] {
  const configured: unknown[] = Array.isArray(payload?.approval_channels)
    ? payload.approval_channels
    : [payload?.approver_channel || 'pxm_user'];
  return configured.reduce<ApprovalChannel[]>((channels, value) => {
    if (
      SUPPORTED_CHANNELS.has(value as ApprovalChannel) &&
      !channels.includes(value as ApprovalChannel)
    ) {
      channels.push(value as ApprovalChannel);
    }
    return channels;
  }, []);
}

export function allowsApprovalChannel(
  payload: any,
  channel: ApprovalChannel,
): boolean {
  return approvalChannels(payload).includes(channel);
}

export function primaryApprovalChannel(payload: any): ApprovalChannel {
  const channels = approvalChannels(payload);
  return channels.includes('pxm_user')
    ? 'pxm_user'
    : channels[0] || 'pxm_user';
}
