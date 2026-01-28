export class CreateTemplateDto {
  name: string;
  description?: string;
  nodes: any[]; // React Flow nodes
  edges: any[]; // React Flow edges
}

export class UpdateTemplateDto {
  name?: string;
  description?: string;
  nodes?: any[];
  edges?: any[];
  is_active?: boolean;
}

export class TemplateResponseDto {
  id: string;
  name: string;
  description?: string;
  nodes: any[];
  edges: any[];
  version: number;
  is_active: boolean;
  created_by?: string;
  updated_by?: string;
  created_at: Date;
  updated_at: Date;
}
