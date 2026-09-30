import { diffEntryPointSchemas } from './schema-diff';

const input = (properties: Record<string, any>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
});

describe('diffEntryPointSchemas', () => {
  it('reports no changes for identical schemas', () => {
    const schema = input({ a: { type: 'string' } }, ['a']);
    expect(
      diffEntryPointSchemas(
        { input: schema, output: null },
        { input: schema, output: null },
      ),
    ).toEqual({ changes: [], breaking: false });
  });

  it('treats optional additions and relaxed requirements as safe', () => {
    const result = diffEntryPointSchemas(
      { input: input({ a: { type: 'string' } }, ['a']), output: null },
      {
        input: input({ a: { type: 'string' }, b: { type: 'number' } }),
        output: { type: 'object' },
      },
    );
    expect(result.breaking).toBe(false);
    expect(result.changes.map((change) => change.change)).toEqual([
      'added_optional',
      'became_optional',
      'schema_added',
    ]);
  });

  it('flags changes that break existing callers', () => {
    const result = diffEntryPointSchemas(
      {
        input: input({
          a: { type: 'string' },
          b: { type: 'string', enum: ['x', 'y'] },
          c: { type: 'string' },
          gone: { type: 'string' },
        }),
        output: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
      {
        input: input(
          {
            a: { type: 'number' },
            b: { type: 'string', enum: ['x'] },
            c: { type: 'string' },
            added: { type: 'string' },
          },
          ['c', 'added'],
        ),
        output: { type: 'object' },
      },
    );
    expect(result.breaking).toBe(true);
    expect(
      result.changes
        .filter((change) => change.breaking)
        .map((change) => `${change.change}:${change.field}`),
    ).toEqual([
      'added_required:added',
      'type_changed:a',
      'enum_changed:b',
      'became_required:c',
      'removed:gone',
      'schema_changed:null',
    ]);
  });

  it('treats a widened enum as safe', () => {
    const result = diffEntryPointSchemas(
      { input: input({ b: { type: 'string', enum: ['x'] } }), output: null },
      {
        input: input({ b: { type: 'string', enum: ['x', 'y'] } }),
        output: null,
      },
    );
    expect(result).toMatchObject({
      breaking: false,
      changes: [{ change: 'enum_changed', breaking: false }],
    });
  });
});
