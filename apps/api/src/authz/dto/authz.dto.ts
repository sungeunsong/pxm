import type {
  PxmApiKeyOwnerType,
  PxmApiKeyScope,
  PxmGroupMembership,
  PxmPrincipalStatus,
  PxmRole,
} from '../../db/ports/db.ports';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Matches,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateExternalPrincipalMappingDto {
  @IsString() @MinLength(1) @MaxLength(100) @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  provider: string;
  @IsString() @MinLength(1) @MaxLength(200) @Matches(/^[^\u0000-\u001f\u007f]+$/)
  subject: string;
  @IsString() @MinLength(1) @MaxLength(128)
  group_id: string;
  @IsString() @MinLength(1) @MaxLength(128)
  pxm_user_id: string;
  @IsOptional() @IsString() @MaxLength(100)
  display_name?: string | null;
  @IsOptional() @IsEmail() @MaxLength(254)
  email?: string | null;
  @IsOptional() @IsString() @MaxLength(100)
  department?: string | null;
}

export class UpdateExternalPrincipalMappingDto {
  @IsString() @MinLength(1) @MaxLength(128)
  group_id: string;
  @IsString() @MinLength(1) @MaxLength(128)
  pxm_user_id: string;
  @IsOptional() @IsString() @MaxLength(100)
  display_name?: string | null;
  @IsOptional() @IsEmail() @MaxLength(254)
  email?: string | null;
  @IsOptional() @IsString() @MaxLength(100)
  department?: string | null;
}

export class SetExternalPrincipalMappingStatusDto {
  @IsIn(['active', 'disabled'])
  status: 'active' | 'disabled';
}

class GroupMembershipDto {
  @IsString() @MinLength(1) @MaxLength(128)
  group_id: string;

  @IsIn(['group_manager', 'user'])
  role: 'group_manager' | 'user';
}

export class UpsertGroupDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128)
  id?: string;
  @IsString() @MinLength(1) @MaxLength(100)
  name: string;
  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;
  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
}

export class UpsertUserDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128)
  id?: string;
  @IsString() @MinLength(1) @MaxLength(100)
  display_name: string;
  @IsOptional() @IsEmail() @MaxLength(254)
  email?: string | null;
  @IsOptional() @IsIn(['admin', 'group_manager', 'user'])
  role?: PxmRole;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true })
  group_ids?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => GroupMembershipDto)
  memberships?: PxmGroupMembership[];
  @IsOptional() @IsIn(['active', 'disabled', 'deleted'])
  status?: PxmPrincipalStatus;
  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
  @IsOptional() @IsString() @MinLength(12) @MaxLength(1024)
  password?: string;
}

export class UpsertServiceAccountDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128)
  id?: string;
  @IsString() @MinLength(1) @MaxLength(100)
  name: string;
  @IsString() @MinLength(1) @MaxLength(128)
  group_id: string;
  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;
  @IsOptional() @IsIn(['active', 'disabled', 'deleted'])
  status?: PxmPrincipalStatus;
  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
}

export class CreateApiKeyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128)
  id?: string;
  @IsString() @MinLength(1) @MaxLength(100)
  name: string;
  @IsIn(['USER', 'SERVICE_ACCOUNT'])
  owner_type: PxmApiKeyOwnerType;
  @IsString() @MinLength(1) @MaxLength(128)
  owner_id: string;
  @IsString() @MinLength(1) @MaxLength(128)
  group_id: string;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsIn(['workflow:read', 'workflow:execute', 'task:approve'], { each: true })
  scopes?: PxmApiKeyScope[];
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsString({ each: true })
  allowed_workflow_ids?: string[];
  // Exact IP and IPv4 CIDR syntax is normalized and validated by AuthzService.
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true })
  ip_allowlist?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(100000)
  rate_limit_per_minute?: number | null;
  @IsOptional() @IsISO8601()
  expires_at?: string | null;
  @IsOptional() @IsString() @MaxLength(128)
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
  ip_allowlist: string[];
  rate_limit_per_minute?: number | null;
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
