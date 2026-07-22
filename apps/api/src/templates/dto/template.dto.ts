import { ArrayMaxSize, IsArray, IsBoolean, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;
  @IsOptional()
  @IsString()
  @MaxLength(100)
  group?: string;
  @IsOptional()
  @IsString()
  @MaxLength(128)
  group_id?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  tags?: string[];
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  version_note?: string;
  @IsOptional()
  @IsObject()
  imported_from?: WorkflowImportSourceMetadata;
  @IsOptional()
  @IsString()
  @MaxLength(128)
  created_by?: string;
  @IsOptional()
  @IsString()
  @MaxLength(128)
  updated_by?: string;
  @IsArray()
  @ArrayMaxSize(5000)
  nodes: any[]; // React Flow nodes
  @IsArray()
  @ArrayMaxSize(10000)
  edges: any[]; // React Flow edges
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;
  @IsOptional()
  @IsString()
  @MaxLength(100)
  group?: string;
  @IsOptional()
  @IsString()
  @MaxLength(128)
  group_id?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  tags?: string[];
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  version_note?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  nodes?: any[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10000)
  edges?: any[];
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
  @IsOptional()
  @IsString()
  @MaxLength(128)
  updated_by?: string;
}

export class TemplateResponseDto {
  id: string;
  name: string;
  description?: string;
  group?: string;
  group_id?: string | null;
  tags: string[];
  version_note?: string;
  imported_from?: WorkflowImportSourceMetadata;
  nodes: any[];
  edges: any[];
  version: number;
  is_active: boolean;
  lifecycle_status: 'DRAFT' | 'PUBLISHED' | 'DISABLED';
  active_published_version: number | null;
  has_unpublished_changes: boolean;
  published_at?: string | null;
  published_by?: string | null;
  created_by?: string;
  updated_by?: string;
  created_at: Date;
  updated_at: Date;
}

export type WorkflowExportDocument = {
  schema_version: 'pxm.workflow.v1';
  exported_at: string;
  workflow: {
    definition_id?: string;
    version?: number;
    exported_version_note?: string;
    name: string;
    metadata: {
      description?: string;
      group?: string;
      group_id?: string | null;
      tags: string[];
      version_note?: string;
      imported_from?: WorkflowImportSourceMetadata;
    };
    nodes: any[];
    edges: any[];
    plugin_dependencies: Array<{
      plugin_id: string;
      version?: string;
      node_ids: string[];
    }>;
  };
  security: {
    secrets_policy: 'redacted';
    redacted_paths: string[];
  };
};

export type WorkflowImportSourceMetadata = {
  schema_version: string;
  definition_id?: string;
  version?: number;
  exported_version_note?: string;
  exported_at?: string;
};
