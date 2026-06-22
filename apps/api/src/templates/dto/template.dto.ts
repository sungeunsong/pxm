export class CreateTemplateDto {
  name: string;
  description?: string;
  group?: string;
  tags?: string[];
  version_note?: string;
  nodes: any[]; // React Flow nodes
  edges: any[]; // React Flow edges
}

export class UpdateTemplateDto {
  name?: string;
  description?: string;
  group?: string;
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
  tags: string[];
  version_note?: string;
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
    name: string;
    metadata: {
      description?: string;
      group?: string;
      tags: string[];
      version_note?: string;
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
