export class CreateTemplateDto {
  name: string;
  description?: string;
  group?: string;
  group_id?: string | null;
  tags?: string[];
  version_note?: string;
  imported_from?: WorkflowImportSourceMetadata;
  nodes: any[]; // React Flow nodes
  edges: any[]; // React Flow edges
}

export class UpdateTemplateDto {
  name?: string;
  description?: string;
  group?: string;
  group_id?: string | null;
  tags?: string[];
  version_note?: string;
  nodes?: any[];
  edges?: any[];
  is_active?: boolean;
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
