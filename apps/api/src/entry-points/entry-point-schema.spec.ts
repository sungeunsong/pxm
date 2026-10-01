import {
  checkManualSchemaAgainstForm,
  checkSchemaDialect,
  deriveInputSchema,
  resolveOutputSchema,
} from './entry-point-schema';

const start = (fields: any[]) => ({
  id: 'start',
  data: { nodeType: 'start', formSchema: { fields } },
});

describe('deriveInputSchema', () => {
  it('maps form fields to JSON Schema', () => {
    const { schema, blocks } = deriveInputSchema([
      start([
        {
          id: 'user_id',
          type: 'text',
          label: '사용자 ID',
          helperText: '사번',
          required: true,
          pattern: '^[0-9]+$',
          maxLength: 10,
        },
        {
          id: 'days',
          type: 'number',
          label: '기간',
          min: 1,
          max: 30,
          defaultValue: 7,
        },
        { id: 'urgent', type: 'checkbox', label: '긴급' },
        {
          id: 'level',
          type: 'select',
          label: '권한',
          options: ['read', 'write'],
          required: true,
        },
        { id: 'start_date', type: 'date', label: '시작일' },
      ]),
    ]);
    expect(blocks).toEqual([]);
    expect(schema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['user_id', 'level'],
      properties: {
        user_id: {
          type: 'string',
          pattern: '^[0-9]+$',
          maxLength: 10,
          description: '사용자 ID — 사번',
        },
        days: {
          type: 'number',
          minimum: 1,
          maximum: 30,
          default: 7,
          description: '기간',
        },
        urgent: { type: 'boolean', description: '긴급' },
        level: { type: 'string', enum: ['read', 'write'], description: '권한' },
        start_date: { type: 'string', format: 'date', description: '시작일' },
      },
    });
  });

  it('describes conditional fields instead of requiring them', () => {
    const { schema } = deriveInputSchema([
      start([
        {
          id: 'kind',
          type: 'select',
          label: '유형',
          options: ['temp', 'perm'],
          required: true,
        },
        {
          id: 'until',
          type: 'date',
          label: '종료일',
          required: true,
          condition: { field: 'kind', operator: 'eq', value: 'temp' },
        },
      ]),
    ]);
    expect(schema.required).toEqual(['kind']);
    expect(schema.properties.until.description).toBe(
      '종료일 — 유형이(가) temp일 때 필수',
    );
  });

  it('blocks missing forms and file inputs', () => {
    expect(
      deriveInputSchema([{ id: 's', data: { nodeType: 'start' } }]).blocks.map(
        (item) => item.code,
      ),
    ).toEqual(['INPUT_FORM_MISSING']);
    expect(
      deriveInputSchema([
        start([{ id: 'doc', type: 'file', label: '문서' }]),
      ]).blocks.map((item) => item.code),
    ).toEqual(['FILE_INPUT_UNSUPPORTED']);
  });

  it('adds the dynamic approval input with a warning', () => {
    const result = deriveInputSchema([
      start([{ id: 'reason', type: 'text', label: '사유' }]),
      {
        id: 'a',
        data: { nodeType: 'approval', approvalLineSource: 'dynamic' },
      },
    ]);
    expect(result.schema.properties.approval_request).toMatchObject({
      type: 'object',
    });
    expect(result.warnings.map((item) => item.code)).toEqual([
      'DYNAMIC_APPROVAL_INPUT',
    ]);
  });
});

describe('checkSchemaDialect', () => {
  it('blocks a non-object root', () => {
    expect(
      checkSchemaDialect({ type: 'string' }).blocks.map((item) => item.code),
    ).toEqual(['SCHEMA_NOT_OBJECT']);
  });

  it('warns about constructs some models do not support', () => {
    const { warnings, blocks } = checkSchemaDialect({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: {
          description: 'b',
          oneOf: [{ type: 'string' }, { type: 'number' }],
        },
        c: { description: 'c', $ref: '#/defs/x' },
        d: {
          description: 'd',
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        e: {
          description: 'e',
          type: 'object',
          properties: {
            f: {
              type: 'object',
              properties: { g: { type: 'object', description: 'g' } },
            },
          },
        },
      },
    });
    expect(blocks).toEqual([]);
    expect(warnings.map((item) => `${item.code}:${item.field}`)).toEqual(
      expect.arrayContaining([
        'PROPERTY_DESCRIPTION_MISSING:a',
        'SCHEMA_COMPOSITION:b',
        'SCHEMA_REF:c',
        'SCHEMA_ADDITIONAL_PROPERTIES:d',
        'SCHEMA_DEEP_NESTING:e.f.g',
      ]),
    );
  });
});

describe('checkManualSchemaAgainstForm', () => {
  it('blocks fields the form does not accept and warns on relaxed required fields', () => {
    const nodes = [start([{ id: 'user_id', type: 'text', required: true }])];
    const result = checkManualSchemaAgainstForm(
      {
        type: 'object',
        properties: { user_id: { type: 'string' }, extra: { type: 'string' } },
      },
      nodes,
    );
    expect(result.blocks.map((item) => item.field)).toEqual(['extra']);
    expect(result.warnings.map((item) => item.code)).toEqual([
      'SCHEMA_REQUIRED_MISSING',
    ]);
  });
});

describe('resolveOutputSchema', () => {
  it('uses the End result schema when present', () => {
    const schema = {
      type: 'object',
      properties: { granted: { type: 'boolean' } },
    };
    expect(
      resolveOutputSchema([
        { data: { nodeType: 'end', resultSchema: schema } },
      ]),
    ).toEqual({ schema, blocks: [], warnings: [] });
  });

  it('warns when no End node declares a schema', () => {
    const result = resolveOutputSchema([{ data: { nodeType: 'end' } }]);
    expect(result.schema).toBeNull();
    expect(result.warnings.map((item) => item.code)).toEqual([
      'OUTPUT_SCHEMA_MISSING',
    ]);
  });

  it('ignores business-failure End nodes when checking consistency', () => {
    const schema = { type: 'object' };
    const result = resolveOutputSchema([
      { data: { nodeType: 'end', resultSchema: schema } },
      { data: { nodeType: 'end', outcome: 'failure' } },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('does not publish the schema of a business-failure End as the output', () => {
    const result = resolveOutputSchema([
      { data: { nodeType: 'end' } },
      {
        data: {
          nodeType: 'end',
          outcome: 'failure',
          resultSchema: {
            type: 'object',
            properties: { reason: { type: 'string' } },
          },
        },
      },
    ]);
    expect(result.schema).toBeNull();
    expect(result.warnings.map((item) => item.code)).toEqual([
      'OUTPUT_SCHEMA_MISSING',
    ]);
  });
});
