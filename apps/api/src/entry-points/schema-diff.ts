/**
 * 진입점 버전 교체(rebind) 때 입력·출력 계약이 어떻게 바뀌는지 비교한다.
 * 호출하는 쪽이 깨지는 변경은 breaking으로 표시하고, 확인 없이 교체하지 않는다.
 */
export type SchemaChange = {
  target: 'input' | 'output';
  field: string | null;
  change:
    | 'added_required'
    | 'added_optional'
    | 'removed'
    | 'became_required'
    | 'became_optional'
    | 'type_changed'
    | 'enum_changed'
    | 'schema_changed'
    | 'schema_added'
    | 'schema_removed';
  breaking: boolean;
  before?: unknown;
  after?: unknown;
};

export function diffEntryPointSchemas(
  before: { input: Record<string, any>; output: Record<string, any> | null },
  after: { input: Record<string, any>; output: Record<string, any> | null },
): { changes: SchemaChange[]; breaking: boolean } {
  const changes = [
    ...diffInput(before.input, after.input),
    ...diffOutput(before.output, after.output),
  ];
  return { changes, breaking: changes.some((change) => change.breaking) };
}

function diffInput(
  before: Record<string, any>,
  after: Record<string, any>,
): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const beforeProps = propertiesOf(before);
  const afterProps = propertiesOf(after);
  const beforeRequired = requiredOf(before);
  const afterRequired = requiredOf(after);

  for (const [field, schema] of Object.entries(afterProps)) {
    if (!(field in beforeProps)) {
      const required = afterRequired.has(field);
      changes.push({
        target: 'input',
        field,
        change: required ? 'added_required' : 'added_optional',
        breaking: required,
        after: schema,
      });
    }
  }
  for (const [field, schema] of Object.entries(beforeProps)) {
    if (!(field in afterProps)) {
      // 없어진 항목을 계속 보내면 실행 때 거부된다
      changes.push({
        target: 'input',
        field,
        change: 'removed',
        breaking: true,
        before: schema,
      });
      continue;
    }
    const next = afterProps[field];
    if (schema?.type !== next?.type || schema?.format !== next?.format) {
      changes.push({
        target: 'input',
        field,
        change: 'type_changed',
        breaking: true,
        before: schema?.type,
        after: next?.type,
      });
    }
    if (
      JSON.stringify(schema?.enum ?? null) !==
      JSON.stringify(next?.enum ?? null)
    ) {
      const removedOption =
        Array.isArray(schema?.enum) &&
        (!Array.isArray(next?.enum)
          ? false
          : schema.enum.some((value: unknown) => !next.enum.includes(value)));
      const newlyRestricted =
        !Array.isArray(schema?.enum) && Array.isArray(next?.enum);
      changes.push({
        target: 'input',
        field,
        change: 'enum_changed',
        breaking: removedOption || newlyRestricted,
        before: schema?.enum,
        after: next?.enum,
      });
    }
    if (!beforeRequired.has(field) && afterRequired.has(field)) {
      changes.push({
        target: 'input',
        field,
        change: 'became_required',
        breaking: true,
      });
    } else if (beforeRequired.has(field) && !afterRequired.has(field)) {
      changes.push({
        target: 'input',
        field,
        change: 'became_optional',
        breaking: false,
      });
    }
  }
  return changes;
}

function diffOutput(
  before: Record<string, any> | null,
  after: Record<string, any> | null,
): SchemaChange[] {
  if (!before && !after) return [];
  if (!before)
    return [
      {
        target: 'output',
        field: null,
        change: 'schema_added',
        breaking: false,
      },
    ];
  if (!after)
    return [
      {
        target: 'output',
        field: null,
        change: 'schema_removed',
        breaking: true,
      },
    ];
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [
    {
      target: 'output',
      field: null,
      change: 'schema_changed',
      breaking: true,
      before,
      after,
    },
  ];
}

function propertiesOf(schema: Record<string, any>): Record<string, any> {
  return schema?.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {};
}

function requiredOf(schema: Record<string, any>): Set<string> {
  return new Set(Array.isArray(schema?.required) ? schema.required : []);
}
