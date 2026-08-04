import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class LookupSshHostKeyDto {
  @IsString() @MinLength(1) @MaxLength(128)
  group_id: string;
  @IsString() @MinLength(1) @MaxLength(255)
  host: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535)
  port?: number;
}

export type CredentialType =
  | 'api_key'
  | 'basic_auth'
  | 'bearer_token'
  | 'connection_string'
  | 'ssh'
  | 'custom';

export class CreateCredentialDto {
  @IsString() @MinLength(1) @MaxLength(128)
  group_id: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true })
  shared_group_ids?: string[];
  @IsString() @MinLength(1) @MaxLength(100)
  name: string;
  @IsIn(['api_key', 'basic_auth', 'bearer_token', 'connection_string', 'ssh', 'custom'])
  type: CredentialType;
  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true })
  scopes?: string[];
  @IsString() @MinLength(1) @MaxLength(65536)
  secret_value: string;
  @IsOptional() @IsObject()
  metadata?: Record<string, any>;
}

export class UpdateCredentialDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128)
  group_id?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true })
  shared_group_ids?: string[];
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100)
  name?: string;
  @IsOptional() @IsIn(['api_key', 'basic_auth', 'bearer_token', 'connection_string', 'ssh', 'custom'])
  type?: CredentialType;
  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true })
  scopes?: string[];
  @IsOptional() @IsString() @MinLength(1) @MaxLength(65536)
  secret_value?: string;
  @IsOptional() @IsObject()
  metadata?: Record<string, any>;
  @IsOptional() @IsBoolean()
  active?: boolean;
}

export type CredentialResponseDto = {
  id: string;
  group_id: string | null;
  shared_group_ids: string[];
  access_level: 'owner' | 'shared';
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
  created_by?: string | null;
  updated_by?: string | null;
};

export type CredentialAuditResponseDto = {
  id: string;
  credential_id: string;
  group_id?: string | null;
  action: string;
  actor: string;
  node_id?: string | null;
  workflow_id?: string | null;
  details?: Record<string, unknown> | null;
  created_at: string;
};
