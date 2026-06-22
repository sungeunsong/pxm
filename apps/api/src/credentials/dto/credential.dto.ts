export type CredentialType =
  | 'api_key'
  | 'basic_auth'
  | 'bearer_token'
  | 'connection_string'
  | 'custom';

export class CreateCredentialDto {
  name: string;
  type: CredentialType;
  description?: string;
  scopes?: string[];
  secret_value: string;
  metadata?: Record<string, any>;
}

export class UpdateCredentialDto {
  name?: string;
  type?: CredentialType;
  description?: string;
  scopes?: string[];
  secret_value?: string;
  metadata?: Record<string, any>;
  active?: boolean;
}

export type CredentialResponseDto = {
  id: string;
  name: string;
  type: CredentialType;
  description: string;
  scopes: string[];
  metadata: Record<string, any>;
  active: boolean;
  has_secret: boolean;
  created_at: string;
  updated_at: string;
  last_used_at?: string | null;
};

export type CredentialAuditResponseDto = {
  id: string;
  credential_id: string;
  action: string;
  actor: string;
  node_id?: string | null;
  workflow_id?: string | null;
  created_at: string;
};
