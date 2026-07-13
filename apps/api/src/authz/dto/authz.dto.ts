import type {
  PxmApiKeyOwnerType,
  PxmApiKeyScope,
  PxmPrincipalStatus,
  PxmRole,
} from '../../db/ports/db.ports';

export class UpsertGroupDto {
  id?: string;
  name: string;
  description?: string;
  actor?: string;
}

export class UpsertUserDto {
  id?: string;
  display_name: string;
  email?: string | null;
  role?: PxmRole;
  group_ids?: string[];
  status?: PxmPrincipalStatus;
  actor?: string;
  password?: string;
}

export class UpsertServiceAccountDto {
  id?: string;
  name: string;
  group_id: string;
  description?: string;
  status?: PxmPrincipalStatus;
  actor?: string;
}

export class CreateApiKeyDto {
  id?: string;
  name: string;
  owner_type: PxmApiKeyOwnerType;
  owner_id: string;
  group_id: string;
  scopes?: PxmApiKeyScope[];
  allowed_workflow_ids?: string[];
  expires_at?: string | null;
  actor?: string;
}

export type ApiKeyResponseDto = {
  id: string;
  name: string;
  owner_type: PxmApiKeyOwnerType;
  owner_id: string;
  group_id: string;
  key_prefix: string;
  scopes: PxmApiKeyScope[];
  allowed_workflow_ids: string[];
  status: string;
  expires_at?: string | null;
  last_used_at?: string | null;
  created_by?: string | null;
  disabled_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type CreatedApiKeyResponseDto = ApiKeyResponseDto & {
  api_key: string;
};
