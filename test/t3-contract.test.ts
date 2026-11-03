import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  checkInputs, compareContracts, REQUIRED_TOOLS, snapshotContract, type AdvertisedTool,
} from '../scripts/lib/t3-contract.ts';
import { startFakeT3 } from './helpers/fakeT3.ts';

const TOOL = 't3_thread_read';
const contract = (inputSchema: Record<string, unknown>, outputSchema?: Record<string, unknown>) => snapshotContract([
  { name: TOOL, inputSchema, ...(outputSchema === undefined ? {} : { outputSchema }) },
]);
const permissiveTools = (): AdvertisedTool[] => REQUIRED_TOOLS.filter((name) => name !== 't3_pending_request')
  .map((name) => ({ name, inputSchema: { type: 'object' } }));
function inputCheck(name: string, inputSchema: Record<string, unknown>) {
  const tools = permissiveTools();
  tools.find((tool) => tool.name === name)!.inputSchema = inputSchema;
  return checkInputs(tools).find((check) => check.tool === name)!;
}

describe('T3 contract snapshots', () => {
  test('ignores schema annotations, map ordering, set ordering and unrelated tools', () => {
    const before = contract({
      type: 'object', title: 'Old title', description: 'Old documentation', examples: [{ hidden: 'example' }],
      properties: { b: { type: ['null', 'string'], description: 'Old field text' }, a: { enum: ['blue', 'green'] } },
      required: ['b', 'a'],
    });
    const afterTools: AdvertisedTool[] = [{
      name: TOOL, inputSchema: {
        required: ['a', 'b'], $comment: 'Internal documentation', description: 'New documentation',
        properties: { a: { enum: ['green', 'blue'] }, b: { examples: ['sample'], type: ['string', 'null'] } },
        type: 'object',
      },
    }, { name: 'new_unrelated_tool', inputSchema: { type: 'object' } }];
    const after = snapshotContract(afterTools);
    assert.deepEqual(before, after);
    assert.deepEqual(compareContracts(before, after), []);
    assert.deepEqual(afterTools[0]!.inputSchema.required, ['a', 'b'], 'normalization never mutates discovery');
  });

  test('retains property names and literal const/enum data that look like schema annotations', () => {
    const before = contract({
      type: 'object', properties: {
        description: { type: 'string' }, title: { type: 'string' },
        selected: { const: { title: 'one', description: 'literal' } },
        choice: { enum: [{ description: 'literal-a', title: 'literal-title' }] },
      },
    });
    const properties = before[TOOL]!.inputSchema.properties as Record<string, unknown>;
    assert.deepEqual(properties.description, { type: 'string' });
    assert.deepEqual(properties.title, { type: 'string' });
    assert.deepEqual(properties.selected, { const: { description: 'literal', title: 'one' } });
    const after = structuredClone(before);
    (after[TOOL]!.inputSchema.properties as Record<string, unknown>).description = { type: 'number' };
    assert.deepEqual(compareContracts(before, after), [{ tool: TOOL, kind: 'changed', paths: ['/inputSchema/properties/description/type'] }]);
    const changedLiteral = contract({ type: 'object', properties: {
      ...properties, selected: { const: { title: 'two', description: 'literal' } },
    } });
    assert.deepEqual(compareContracts(before, changedLiteral)[0]!.paths, ['/inputSchema/properties/selected/const']);
  });

  test('retains tuple and literal array order, and unfamiliar schema extensions', () => {
    for (const keyword of ['prefixItems', 'const', 'allOf', 'customExtension']) {
      const before = contract({ [keyword]: [{ title: 'a', type: 'string' }, { title: 'b', type: 'number' }] });
      const after = contract({ [keyword]: [{ title: 'b', type: 'number' }, { title: 'a', type: 'string' }] });
      assert.equal(compareContracts(before, after).length, 1, keyword);
    }
  });

  test('keeps changed defaults visible because the gateway omits optional inputs', () => {
    const before = contract({ properties: { view: { type: 'string', default: 'messages' } } });
    const after = contract({ properties: { view: { type: 'string', default: 'activity' } } });
    assert.deepEqual(compareContracts(before, after), [{ tool: TOOL, kind: 'changed', paths: ['/inputSchema/properties/view/default'] }]);
  });

  test('retains referenced annotation schemas and indexed enum order instead of hiding semantic changes', () => {
    const output = (type: string) => ({
      type: 'object', properties: { result: { $ref: '#/examples/0' } }, examples: [{ type }],
    });
    const before = contract({ type: 'object' }, output('string'));
    const after = contract({ type: 'object' }, output('number'));
    assert.deepEqual(before[TOOL]!.outputSchema!.examples, [{ type: 'string' }]);
    assert.deepEqual(compareContracts(before, after), [{ tool: TOOL, kind: 'changed', paths: ['/outputSchema/examples'] }]);

    const alternatives = [{ type: 'string' }, { type: 'number' }];
    const schema = (values: typeof alternatives) => ({
      type: 'object', properties: { threadId: { $ref: '#/$defs/alternatives/enum/0' } },
      $defs: { alternatives: { enum: values } },
    });
    assert.deepEqual(compareContracts(contract(schema(alternatives)), contract(schema([...alternatives].reverse()))), [
      { tool: TOOL, kind: 'changed', paths: ['/inputSchema/$defs/alternatives/enum'] },
    ]);
  });

  test('detects required tool and optional output schema additions and removals', () => {
    const before = contract({ type: 'object' });
    const after = contract({ type: 'object' }, { type: 'object', properties: { value: { type: 'string' } } });
    assert.deepEqual(compareContracts(before, after), [{ tool: TOOL, kind: 'changed', paths: ['/outputSchema'] }]);
    assert.deepEqual(compareContracts(after, before), [{ tool: TOOL, kind: 'changed', paths: ['/outputSchema'] }]);
    assert.deepEqual(compareContracts({}, before), [{ tool: TOOL, kind: 'added', paths: [] }]);
    assert.deepEqual(compareContracts(before, {}), [{ tool: TOOL, kind: 'removed', paths: [] }]);
  });

  test('bounds changed paths and escapes JSON Pointer keys without exposing values', () => {
    const before = contract({ properties: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`property/${i}~`, { type: 'string' }])) });
    const after = contract({ properties: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`property/${i}~`, { const: 'never-print-this' }])) });
    const changes = compareContracts(before, after);
    assert.equal(changes[0]!.paths.length, 20);
    assert.ok(changes[0]!.paths.every((path) => path.includes('~1') && path.includes('~0')));
    assert.ok(!JSON.stringify(changes).includes('never-print-this'));
  });

  test('rejects duplicate names with a fixed message, including unrelated duplicates', () => {
    const repeated = { name: 'untrusted-name-that-should-not-be-printed', inputSchema: { type: 'object' } };
    assert.throws(() => snapshotContract([repeated, repeated]), { message: 'duplicate_tool' });
    assert.throws(() => checkInputs([repeated, repeated]), { message: 'duplicate_tool' });
  });
});

describe('T3 advertised input checks', () => {
  for (const pendingRequestTools of ['legacy', 'combined', 'both'] as const) test(`accepts published schemas without invoking any tool (${pendingRequestTools})`, async (t) => {
    const fake = await startFakeT3({ pendingRequestTools });
    const token = 'synthetic-discovery-token';
    fake.validTokens.add(token);
    const client = new Client({ name: 'compatibility-test', version: '0.0.0' });
    t.after(async () => { await client.close(); await fake.close(); });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', fake.url), { authProvider: { token: async () => token } }));
    const tools = (await client.listTools()).tools;
    const checks = checkInputs(tools);
    assert.equal(checks.length, pendingRequestTools === 'legacy' ? 13 : 11);
    assert.ok(checks.every((check) => check.status === 'pass'), JSON.stringify(checks));
    assert.deepEqual(fake.calls, [], 'discovery and schema validation must not call mutation or read tools');
  });

  test('accepts compact optional schemas and validates all combined actions', () => {
    const tools = permissiveTools().filter((tool) => !tool.name.startsWith('t3_pending_request_'));
    const combined = { name: 't3_pending_request', inputSchema: {
      type: 'object', required: ['action'], properties: {
        action: { enum: ['list', 'read', 'respond'] }, threadId: { type: 'string' }, requestId: { type: 'string' }, answers: { type: 'object' },
      },
    } };
    tools.push(combined);
    assert.ok(checkInputs(tools).every((check) => check.status === 'pass'));
    assert.ok(snapshotContract(tools).t3_pending_request);
    assert.ok(!snapshotContract(tools).t3_pending_request_list);
    combined.inputSchema.properties.action.enum = ['list', 'read'];
    assert.deepEqual(checkInputs(tools).filter((check) => check.status !== 'pass'), [
      { tool: 't3_pending_request', status: 'fail', code: 'sample_input_rejected' },
    ]);
    tools.pop();
    assert.equal(checkInputs(tools).filter((check) => check.code === 'required_tool_missing').length, 3);
  });

  test('missing required tools fail, while extra tools are ignored', () => {
    const tools = permissiveTools().filter((tool) => tool.name !== 't3_thread_send');
    tools.push({ name: 'unrelated', inputSchema: { type: 'object' } });
    const checks = checkInputs(tools);
    assert.equal(checks.length, 12);
    assert.deepEqual(checks.filter((check) => check.status !== 'pass'), [
      { tool: 't3_thread_send', status: 'fail', code: 'required_tool_missing' },
    ]);
  });

  test('rejects incompatible new required fields, types, enum restrictions and long pending ID caps', () => {
    for (const inputSchema of [
      { type: 'object', required: ['newRequiredField'] },
      { type: 'object', properties: { threadId: { type: 'number' } } },
      { type: 'object', properties: { view: { enum: ['messages'] } } },
    ]) {
      assert.deepEqual(inputCheck(TOOL, inputSchema), { tool: TOOL, status: 'fail', code: 'sample_input_rejected' });
    }
    for (const name of ['t3_pending_request_read', 't3_pending_request_respond']) {
      assert.equal(inputCheck(name, { type: 'object', properties: { requestId: { type: 'string', maxLength: 200 } } }).status, 'fail');
    }
  });

  test('a launch schema without the scratch flag fails, because scratch aliases launch with it', () => {
    const launch = (scratch: boolean) => ({
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string' }, title: { type: 'string' }, message: { type: 'string' }, modelSelection: { type: 'object' },
        runtimeMode: { type: 'string' }, workspaceStrategy: { type: 'object' }, ...(scratch ? { scratch: { type: 'boolean' } } : {}),
      },
    });
    assert.deepEqual(inputCheck('t3_thread_launch', launch(false)), { tool: 't3_thread_launch', status: 'fail', code: 'sample_input_rejected' });
    assert.equal(inputCheck('t3_thread_launch', launch(true)).status, 'pass');
  });

  test('warns on unsupported schemas and formats without printing validator errors', (t) => {
    const warnings: unknown[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
    for (const inputSchema of [
      { $schema: 'https://example.invalid/unknown-schema', type: 'object' },
      { type: 'object', properties: { threadId: { format: 'private-format-text' } } },
      { type: 'object', properties: { threadId: { $ref: '#/missing-private-definition' } } },
      { type: 'object', properties: { threadId: { futureConstraint: 'private-constraint-text' } } },
    ]) {
      assert.deepEqual(inputCheck(TOOL, inputSchema), { tool: TOOL, status: 'warn', code: 'input_schema_unsupported' });
    }
    assert.deepEqual(warnings, []);
  });

  test('guards references into uninspected data before validation and never prints their values', (t) => {
    const output: unknown[] = [];
    for (const method of ['warn', 'log', 'error'] as const) t.mock.method(console, method, (...args: unknown[]) => output.push(args));
    for (const target of [
      { type: 'string', format: 'PRIVATE_FORMAT_FROM_REF' },
      { type: 'string', futureConstraint: 'PRIVATE_CONSTRAINT_FROM_REF' },
    ]) {
      for (const [keyword, value, reference] of [
        ['examples', [target], '#/examples/0'],
        ['description', target, '#/description'],
        ['const', target, '#/const'],
      ] as const) {
        const schema = { type: 'object', properties: { threadId: { $ref: reference } }, [keyword]: value };
        assert.deepEqual(inputCheck(TOOL, schema), { tool: TOOL, status: 'warn', code: 'input_schema_unsupported' });
      }
    }
    assert.deepEqual(output, []);
  });

  test('accepts guarded local pointers and keeps unsupported reference resolution unverified', (t) => {
    const output: unknown[] = [];
    for (const method of ['warn', 'log', 'error'] as const) t.mock.method(console, method, (...args: unknown[]) => output.push(args));
    const local = {
      type: 'object', properties: { threadId: { $ref: '#/$defs/identifier' } }, $defs: { identifier: { type: 'string' } },
    };
    const unchanged = structuredClone(local);
    assert.equal(inputCheck(TOOL, local).status, 'pass');
    assert.deepEqual(local, unchanged, 'validation must not annotate the caller schema');
    assert.equal(inputCheck(TOOL, {
      ...local, $defs: { identifier: { type: 'number' } },
    }).status, 'fail', 'the referenced constraint actually applies');
    for (const reference of [
      { $ref: '#identifier' },
      { $ref: 'https://example.invalid/schema#/$defs/identifier' },
      { $dynamicRef: '#/$defs/identifier' },
      { $recursiveRef: '#' },
      { $ref: '#/$defs/missing' },
      { $ref: '#/%XX' },
    ]) {
      assert.equal(inputCheck(TOOL, { ...local, properties: { threadId: reference } }).status, 'warn');
    }
    assert.equal(inputCheck(TOOL, { ...local, $defs: { identifier: { $id: 'nested', type: 'string' } } }).status, 'warn');
    assert.deepEqual(output, []);
  });

  test('validator exceptions and unsupported extensions remain silent and unverified', (t) => {
    const output: unknown[] = [];
    for (const method of ['warn', 'log', 'error'] as const) t.mock.method(console, method, (...args: unknown[]) => output.push(args));
    for (const rule of [
      { type: 'string', pattern: '(PRIVATE_INVALID_PATTERN' },
      { type: 'string', format: 'iso-date-time' },
      { type: 'string', nullable: true },
    ]) {
      assert.equal(inputCheck(TOOL, { type: 'object', properties: { threadId: rule } }).status, 'warn');
    }
    assert.deepEqual(output, []);
  });

  test('a repeated schema ID does not reuse a different tool schema', () => {
    const tools = permissiveTools();
    tools[0]!.inputSchema = { $id: 'https://example.invalid/shared', type: 'object' };
    tools[1]!.inputSchema = { $id: 'https://example.invalid/shared', type: 'object', required: ['missing'] };
    const checks = checkInputs(tools);
    assert.equal(checks[0]!.status, 'pass');
    assert.equal(checks[1]!.status, 'fail');
  });
});


test('compatibility probe validates exact settlement inputs against a strict organize schema without requiring it on older hosts', () => {
  const tools = permissiveTools();
  assert.ok(checkInputs(tools).every((check) => check.status === 'pass'));
  const organize: AdvertisedTool = { name: 't3_thread_organize', inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: { threadId: { type: 'string' }, action: { enum: ['pin', 'settle', 'archive'] } },
  } };
  tools.push(organize);
  assert.equal(checkInputs(tools).find((check) => check.tool === organize.name)?.status, 'pass');
  assert.ok(snapshotContract(tools)[organize.name]);
  organize.inputSchema.required = ['action', 'newRequiredField'];
  assert.equal(checkInputs(tools).find((check) => check.tool === organize.name)?.status, 'fail');
});
