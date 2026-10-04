import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ErrorCode, TorosError, type JsonValue, type Workspace } from '@toros/contracts';

import { createRegistry } from '../src/index.js';
import { createMockAdapter } from './mock-adapter.js';

const WORKSPACES: readonly Workspace[] = [{ id: 'ws', root: 'C:\\workspace' }];

function registry(platform: 'win32' | 'darwin' | 'linux' = 'win32') {
  return createRegistry({ workspaces: WORKSPACES, platform });
}

/** Narrow an unknown rejection to TorosError with the expected code. */
function expectTorosError(err: unknown, code: string): asserts err is TorosError {
  assert.ok(err instanceof TorosError, `expected TorosError, got ${String(err)}`);
  assert.equal(err.code, code);
}

describe('@toros/registry', () => {
  it('registers a valid adapter and lists its capabilities as adapter.action', async () => {
    const reg = registry();
    const adapter = createMockAdapter({
      id: 'tool',
      actions: [
        {
          id: 'read',
          summary: 'Read a path',
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
          path_fields: [], mutates: false,
          always_requires_approval: false,
        },
        {
          id: 'write',
          summary: 'Write a path',
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string' }, body: { type: 'string' } },
            required: ['path', 'body'],
          },
          path_fields: [], mutates: true,
          always_requires_approval: false,
        },
      ],
    });

    await reg.register(adapter);

    const listed = reg.list();
    assert.ok(listed.includes('tool.read'));
    assert.ok(listed.includes('tool.write'));
    assert.equal(listed.length, 2);

    const got = reg.get('tool.read');
    if (got === null) {
      assert.fail('expected tool.read to resolve');
    }
    assert.equal(got.adapter, adapter);
    assert.equal(got.actionId, 'read');
  });

  it('list returns capabilities sorted and is unaffected by any envelope', async () => {
    const reg = registry();
    await reg.register(
      createMockAdapter({
        id: 'zebra',
        actions: [
          {
            id: 'b',
            summary: 'b',
            input_schema: { type: 'object' },
            path_fields: [], mutates: false,
            always_requires_approval: false,
          },
          {
            id: 'a',
            summary: 'a',
            input_schema: { type: 'object' },
            path_fields: [], mutates: false,
            always_requires_approval: false,
          },
        ],
      }),
    );
    await reg.register(
      createMockAdapter({
        id: 'alpha',
        actions: [
          {
            id: 'z',
            summary: 'z',
            input_schema: { type: 'object' },
            path_fields: [], mutates: false,
            always_requires_approval: false,
          },
        ],
      }),
    );

    assert.deepEqual(reg.list(), ['alpha.z', 'zebra.a', 'zebra.b']);
    // Registry has no envelope API — list is just the registered set.
    assert.deepEqual(reg.workspaces(), WORKSPACES);
  });

  it('rejects a duplicate adapter id', async () => {
    const reg = registry();
    await reg.register(createMockAdapter({ id: 'dup' }));

    await assert.rejects(
      () => reg.register(createMockAdapter({ id: 'dup' })),
      (err: unknown) => {
        expectTorosError(err, ErrorCode.E_ENVELOPE_INVALID);
        return true;
      },
    );
  });

  it('rejects a manifest whose platforms exclude this node with E_NOT_REGISTERED', async () => {
    const reg = registry('win32');
    const adapter = createMockAdapter({
      id: 'mac_only',
      platforms: ['darwin'],
    });

    await assert.rejects(
      () => reg.register(adapter),
      (err: unknown) => {
        expectTorosError(err, ErrorCode.E_NOT_REGISTERED);
        return true;
      },
    );
    assert.equal(adapter.initCalled, false);
    assert.deepEqual(reg.list(), []);
  });

  it('rejects duplicate action ids within one manifest', async () => {
    const reg = registry();
    await assert.rejects(
      () =>
        reg.register(
          createMockAdapter({
            id: 'dup_actions',
            actions: [
              {
                id: 'same',
                summary: 'one',
                input_schema: { type: 'object' },
                path_fields: [], mutates: false,
                always_requires_approval: false,
              },
              {
                id: 'same',
                summary: 'two',
                input_schema: { type: 'object' },
                path_fields: [], mutates: false,
                always_requires_approval: false,
              },
            ],
          }),
        ),
      (err: unknown) => {
        expectTorosError(err, ErrorCode.E_ENVELOPE_INVALID);
        return true;
      },
    );
  });

  it('rejects an uncompilable input_schema with E_SCHEMA', async () => {
    const reg = registry();
    // strict: true rejects unknown keywords; a typo'd keyword is uncompilable.
    // Build an invalid schema document without lying to the type system about JsonValue.
    const brokenSchema: JsonValue = {
      type: 'object',
      propertees: { x: { type: 'string' } },
    };

    await assert.rejects(
      () =>
        reg.register(
          createMockAdapter({
            id: 'bad_schema',
            actions: [
              {
                id: 'act',
                summary: 'broken schema',
                input_schema: brokenSchema,
                path_fields: [], mutates: false,
                always_requires_approval: false,
              },
            ],
          }),
        ),
      (err: unknown) => {
        expectTorosError(err, ErrorCode.E_SCHEMA);
        return true;
      },
    );
  });

  it('validates the manifest before calling init', async () => {
    const reg = registry();
    const adapter = createMockAdapter({
      id: 'Not_Valid',
      platforms: ['win32'],
    });

    await assert.rejects(
      () => reg.register(adapter),
      (err: unknown) => {
        expectTorosError(err, ErrorCode.E_ENVELOPE_INVALID);
        return true;
      },
    );
    assert.equal(adapter.initCalled, false, 'init must not run on a rejected adapter');
  });

  it('propagates an init failure and leaves the adapter unregistered', async () => {
    const reg = registry();
    const boom = new Error('host refuses this adapter');
    const adapter = createMockAdapter({ id: 'flaky', initError: boom });

    await assert.rejects(
      () => reg.register(adapter),
      (err: unknown) => {
        assert.equal(err, boom);
        return true;
      },
    );
    assert.equal(adapter.initCalled, true);
    assert.deepEqual(reg.list(), []);
    assert.equal(reg.get('flaky.echo'), null);
  });

  it('get returns null for an unknown id rather than throwing', async () => {
    const reg = registry();
    await reg.register(createMockAdapter({ id: 'known' }));
    assert.equal(reg.get('known.missing'), null);
    assert.equal(reg.get('other.echo'), null);
  });

  it('get returns null for a malformed id', () => {
    const reg = registry();
    assert.equal(reg.get('no_dot'), null);
    assert.equal(reg.get('too.many.dots'), null);
    assert.equal(reg.get('.leading'), null);
    assert.equal(reg.get('trailing.'), null);
    assert.equal(reg.get(''), null);
  });

  it('validateArguments accepts arguments matching the schema', async () => {
    const reg = registry();
    await reg.register(createMockAdapter({ id: 'mock' }));
    assert.doesNotThrow(() => {
      reg.validateArguments('mock.echo', { message: 'hello' });
    });
  });

  it('validateArguments throws E_SCHEMA with path and message pairs in detail', async () => {
    const reg = registry();
    await reg.register(createMockAdapter({ id: 'mock' }));

    try {
      // Wrong type for `message` (number instead of string).
      const badArgs: Record<string, JsonValue> = { message: 42 };
      reg.validateArguments('mock.echo', badArgs);
      assert.fail('expected TorosError');
    } catch (err: unknown) {
      expectTorosError(err, ErrorCode.E_SCHEMA);
      assert.equal(err.detail['capability'], 'mock.echo');
      const errors = err.detail['errors'];
      assert.ok(Array.isArray(errors));
      assert.ok(errors.length >= 1);
      for (const e of errors) {
        assert.ok(e !== null && typeof e === 'object');
        const rec = e as Record<string, unknown>;
        assert.equal(typeof rec['path'], 'string');
        assert.equal(typeof rec['message'], 'string');
        assert.equal(Object.keys(rec).sort().join(','), 'message,path');
      }
    }
  });

  it('validateArguments throws E_NOT_REGISTERED for an unknown capability', () => {
    const reg = registry();
    try {
      reg.validateArguments('ghost.act', { x: 1 });
      assert.fail('expected TorosError');
    } catch (err: unknown) {
      expectTorosError(err, ErrorCode.E_NOT_REGISTERED);
      // Must never be E_CAP_NOT_ALLOWED — registry does not know permission.
      assert.notEqual(err.code, ErrorCode.E_CAP_NOT_ALLOWED);
    }
  });

  it('validateArguments does not mutate the arguments object', async () => {
    const reg = registry();
    await reg.register(
      createMockAdapter({
        id: 'defaults',
        actions: [
          {
            id: 'act',
            summary: 'schema with a default',
            input_schema: {
              type: 'object',
              properties: {
                name: { type: 'string', default: 'anonymous' },
              },
              additionalProperties: false,
            },
            path_fields: [], mutates: false,
            always_requires_approval: false,
          },
        ],
      }),
    );

    const args: Record<string, JsonValue> = {};
    const before = JSON.stringify(args);
    reg.validateArguments('defaults.act', args);
    assert.equal(JSON.stringify(args), before, 'args must remain byte-identical');
    assert.equal('name' in args, false);
  });

  it('validateArguments does not coerce a string to a number', async () => {
    const reg = registry();
    await reg.register(
      createMockAdapter({
        id: 'nums',
        actions: [
          {
            id: 'act',
            summary: 'expects a number',
            input_schema: {
              type: 'object',
              properties: {
                count: { type: 'number' },
              },
              required: ['count'],
              additionalProperties: false,
            },
            path_fields: [], mutates: false,
            always_requires_approval: false,
          },
        ],
      }),
    );

    const args: Record<string, JsonValue> = { count: '3' };
    const snapshot = { ...args };

    try {
      reg.validateArguments('nums.act', args);
      assert.fail('string must not coerce to number — should throw E_SCHEMA');
    } catch (err: unknown) {
      expectTorosError(err, ErrorCode.E_SCHEMA);
    }

    assert.deepEqual(args, snapshot);
    assert.equal(typeof args['count'], 'string');
  });

  it('detail does not contain the offending argument values', async () => {
    const reg = registry();
    await reg.register(
      createMockAdapter({
        id: 'secret_holder',
        actions: [
          {
            id: 'set',
            summary: 'set a secret-shaped field',
            input_schema: {
              type: 'object',
              properties: {
                token: { type: 'string', minLength: 32 },
              },
              required: ['token'],
              additionalProperties: false,
            },
            path_fields: [], mutates: true,
            always_requires_approval: true,
          },
        ],
      }),
    );

    const secret = 'super-secret-token-value-that-is-long-enough';
    // Wrong type so validation fails; the value must not appear in detail.
    try {
      const badArgs: Record<string, JsonValue> = { token: 12345 };
      reg.validateArguments('secret_holder.set', badArgs);
      assert.fail('expected TorosError');
    } catch (err: unknown) {
      expectTorosError(err, ErrorCode.E_SCHEMA);
      const serialized = JSON.stringify(err.detail);
      assert.equal(
        serialized.includes('12345'),
        false,
        'numeric offending value must not appear in detail',
      );
      assert.equal(serialized.includes(secret), false);

      // Ensure we only have path/message pairs, not Ajv data/params that hold values.
      const errors = err.detail['errors'];
      assert.ok(Array.isArray(errors));
      for (const e of errors) {
        assert.ok(e !== null && typeof e === 'object');
        const rec = e as Record<string, unknown>;
        assert.deepEqual(Object.keys(rec).sort(), ['message', 'path']);
        assert.equal('data' in rec, false);
        assert.equal('params' in rec, false);
        assert.equal('schemaPath' in rec, false);
      }
    }
  });
});
