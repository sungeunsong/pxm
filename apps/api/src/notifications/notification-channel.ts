export type ApprovalNotificationMessage = {
  to: string;
  title: string;
  requester: string | null;
  stepLabel: string | null;
  inboxUrl: string;
  sourceUrl: string | null;
};

export abstract class ApprovalNotificationChannel {
  abstract readonly kind: 'email';
  abstract isConfigured(): boolean;
  abstract send(message: ApprovalNotificationMessage): Promise<void>;
}
