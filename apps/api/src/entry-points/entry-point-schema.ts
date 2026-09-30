/**
 * 진입점 입력·출력 스키마 — Start 입력 폼과 End 결과 스키마에서 JSON Schema를 만들고 점검한다.
 *
 * 게시하는 순간 이 스키마가 바깥과의 계약이 된다. 실제 입력 검증은 실행 경로에서
 * Start 입력 폼 기준으로 다시 한다(normalizeWorkflowInputValues).
 * 설계: docs/ai-tool-publish-design.md 5장, 10장
 */
import { dynamicApprovalRequestInputKey } from '../instances/external-approval-start';

export type SchemaIssue = {
  code: string;
  message: string;
  field?: string;
};

export type SchemaCheck = {
  blocks: SchemaIssue[];
  warnings: SchemaIssue[];
};

type FormField = {
  id?: string;
  name?: string;
  type?: string;
  label?: string;
  helperText?: string;
  required?: boolean;
  defaultValue?: unknown;
  options?: unknown[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  condition?: { field?: string; operator?: string; value?: unknown };
};

type NodeLike = { id?: string; data?: Record<string, any> };

export function startFormFields(nodes: NodeLike[]): FormField[] {
  const start = nodes.find((node) => node?.data?.nodeType === 'start');
  const fields = start?.data?.formSchema?.fields;
  return Array.isArray(fields)
    ? fields.filter((field: FormField) => field?.id || field?.name)
    : [];
}

/** Start 입력 폼 → JSON Schema. 파일 입력과 폼 없음은 게시를 막는다 */
export function deriveInputSchema(
  nodes: NodeLike[],
): SchemaCheck & { schema: Record<string, any> } {
  const blocks: SchemaIssue[] = [];
  const warnings: SchemaIssue[] = [];
  const fields = startFormFields(nodes);
  const properties: Record<string, any> = {};
  const required: string[] = [];

  if (fields.length === 0) {
    blocks.push({
      code: 'INPUT_FORM_MISSING',
      message:
        'Start 노드에 입력 폼 항목이 없습니다. 입력 폼을 만든 뒤 게시하세요.',
    });
  }

  for (const field of fields) {
    const id = String(field.id || field.name);
    const type = String(field.type || 'text');
    if (type === 'file') {
      blocks.push({
        code: 'FILE_INPUT_UNSUPPORTED',
        field: id,
        message: `파일 입력(${id})은 외부 호출에서 지원하지 않습니다.`,
      });
      continue;
    }
    const property: Record<string, any> = {};
    if (type === 'number') property.type = 'number';
    else if (type === 'checkbox') property.type = 'boolean';
    else property.type = 'string';
    if (type === 'date') property.format = 'date';
    if (
      (type === 'select' || type === 'radio') &&
      Array.isArray(field.options) &&
      field.options.length > 0
    ) {
      property.enum = field.options.map((option) => String(option));
    }
    if (type === 'number') {
      if (Number.isFinite(field.min)) property.minimum = Number(field.min);
      if (Number.isFinite(field.max)) property.maximum = Number(field.max);
    }
    if (property.type === 'string') {
      if (Number.isFinite(field.minLength))
        property.minLength = Number(field.minLength);
      if (Number.isFinite(field.maxLength))
        property.maxLength = Number(field.maxLength);
      if (typeof field.pattern === 'string' && field.pattern)
        property.pattern = field.pattern;
    }
    if (field.defaultValue !== undefined && field.defaultValue !== '')
      property.default = field.defaultValue;

    const description = describeField(field, fields);
    if (description) property.description = description;
    properties[id] = property;
    // 조건부로 보이는 항목은 조건이 맞을 때만 필수라서 스키마의 required에 넣지 않는다
    if (field.required === true && !field.condition) required.push(id);
  }

  const approvalKey = dynamicApprovalRequestInputKey(nodes as any[]);
  if (approvalKey && !properties[approvalKey]) {
    properties[approvalKey] = {
      type: 'object',
      description:
        '결재선. 결재 노드가 호출 시 결재자를 받도록 설정되어 있어 함께 보내야 합니다.',
    };
    warnings.push({
      code: 'DYNAMIC_APPROVAL_INPUT',
      field: approvalKey,
      message: `결재자를 호출할 때 받는 결재 노드가 있습니다. 호출하는 쪽이 ${approvalKey} 값을 채워야 합니다.`,
    });
  }

  const schema: Record<string, any> = {
    type: 'object',
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) schema.required = required;
  return { schema, blocks, warnings };
}

function describeField(field: FormField, fields: FormField[]): string {
  const parts = [field.label, field.helperText]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  if (field.condition?.field) {
    const target = fields.find(
      (item) => String(item.id || item.name) === field.condition?.field,
    );
    const targetName = target?.label || field.condition.field;
    const relation = field.condition.operator === 'neq' ? '아닐 때' : '일 때';
    const requirement = field.required ? '필수' : '사용';
    parts.push(
      `${targetName}이(가) ${String(field.condition.value)}${relation} ${requirement}`,
    );
  }
  return parts.join(' — ');
}

/**
 * 모델 호환성 점검 (5.3). 최상위가 object가 아니면 막고, 나머지는 경고만 한다.
 */
export function checkSchemaDialect(schema: unknown): SchemaCheck {
  const blocks: SchemaIssue[] = [];
  const warnings: SchemaIssue[] = [];
  if (
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    (schema as any).type !== 'object'
  ) {
    blocks.push({
      code: 'SCHEMA_NOT_OBJECT',
      message: '입력 스키마의 최상위는 type: object여야 합니다.',
    });
    return { blocks, warnings };
  }
  const properties = (schema as any).properties;
  if (properties && typeof properties === 'object') {
    for (const [key, value] of Object.entries<any>(properties)) {
      if (
        !value ||
        typeof value !== 'object' ||
        typeof value.description !== 'string' ||
        !value.description.trim()
      ) {
        warnings.push({
          code: 'PROPERTY_DESCRIPTION_MISSING',
          field: key,
          message: `${key} 항목에 설명이 없습니다. AI가 값을 채울 때 설명을 근거로 삼습니다.`,
        });
      }
    }
  }
  walk(schema, 0, '', (node, depth, path) => {
    if ('$ref' in node)
      warnings.push({
        code: 'SCHEMA_REF',
        field: path || undefined,
        message: '$ref는 일부 모델에서 해석되지 않습니다.',
      });
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      if (key in node)
        warnings.push({
          code: 'SCHEMA_COMPOSITION',
          field: path || undefined,
          message: `${key}는 일부 모델에서 지원하지 않습니다.`,
        });
    }
    if (
      node.additionalProperties &&
      typeof node.additionalProperties === 'object'
    ) {
      warnings.push({
        code: 'SCHEMA_ADDITIONAL_PROPERTIES',
        field: path || undefined,
        message:
          'additionalProperties에 스키마를 쓰면 일부 모델에서 표현되지 않습니다.',
      });
    }
    if (depth >= 3 && node.type === 'object') {
      warnings.push({
        code: 'SCHEMA_DEEP_NESTING',
        field: path || undefined,
        message: '3단계 이상 중첩된 객체는 모델이 잘못 채우기 쉽습니다.',
      });
    }
  });
  return { blocks, warnings: dedupe(warnings) };
}

/**
 * 직접 고친 입력 스키마가 Start 입력 폼과 맞는지 본다. 폼에 없는 항목은 실행 때 거부되므로 막는다.
 */
export function checkManualSchemaAgainstForm(
  schema: Record<string, any>,
  nodes: NodeLike[],
): SchemaCheck {
  const blocks: SchemaIssue[] = [];
  const warnings: SchemaIssue[] = [];
  const fields = startFormFields(nodes);
  const fieldIds = new Set(
    fields.map((field) => String(field.id || field.name)),
  );
  const approvalKey = dynamicApprovalRequestInputKey(nodes as any[]);
  if (approvalKey) fieldIds.add(approvalKey);
  const properties =
    schema?.properties && typeof schema.properties === 'object'
      ? Object.keys(schema.properties)
      : [];
  for (const key of properties) {
    if (!fieldIds.has(key)) {
      blocks.push({
        code: 'SCHEMA_UNKNOWN_FIELD',
        field: key,
        message: `${key}는 Start 입력 폼에 없는 항목이라 실행 때 거부됩니다.`,
      });
    }
  }
  const schemaRequired = new Set<string>(
    Array.isArray(schema?.required) ? schema.required : [],
  );
  for (const field of fields) {
    const id = String(field.id || field.name);
    if (
      field.required === true &&
      !field.condition &&
      !schemaRequired.has(id)
    ) {
      warnings.push({
        code: 'SCHEMA_REQUIRED_MISSING',
        field: id,
        message: `${id}는 입력 폼에서 필수인데 스키마에서는 필수가 아닙니다.`,
      });
    }
  }
  return { blocks, warnings };
}

/** End 노드의 결과 스키마. 여러 End가 서로 다른 스키마를 두면 경고한다 */
export function resolveOutputSchema(
  nodes: NodeLike[],
): SchemaCheck & { schema: Record<string, any> | null } {
  const warnings: SchemaIssue[] = [];
  const ends = nodes.filter((node) => node?.data?.nodeType === 'end');
  const schemas = ends
    .map((node) => node.data?.resultSchema)
    .filter(
      (value): value is Record<string, any> =>
        Boolean(value) && typeof value === 'object' && !Array.isArray(value),
    );
  if (schemas.length === 0) {
    warnings.push({
      code: 'OUTPUT_SCHEMA_MISSING',
      message:
        'End 노드에 결과 스키마가 없습니다. 결과 형식을 정하지 않은 채(free_form) 게시합니다.',
    });
    return { schema: null, blocks: [], warnings };
  }
  const distinct = new Set(schemas.map((value) => JSON.stringify(value)));
  if (
    distinct.size > 1 ||
    schemas.length <
      ends.filter((node) => node.data?.outcome !== 'failure').length
  ) {
    warnings.push({
      code: 'OUTPUT_SCHEMA_INCONSISTENT',
      message:
        'End 노드마다 결과 스키마가 다르거나 빠져 있습니다. 첫 번째 스키마를 씁니다.',
    });
  }
  return { schema: schemas[0], blocks: [], warnings };
}

function walk(
  node: any,
  depth: number,
  path: string,
  visit: (node: any, depth: number, path: string) => void,
) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  visit(node, depth, path);
  if (node.properties && typeof node.properties === 'object') {
    for (const [key, child] of Object.entries(node.properties))
      walk(child, depth + 1, path ? `${path}.${key}` : key, visit);
  }
  if (node.items) walk(node.items, depth, `${path}[]`, visit);
}

function dedupe(issues: SchemaIssue[]): SchemaIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.field ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
