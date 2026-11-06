import assert from 'node:assert/strict';
import test from 'node:test';
import { projectMcpToolResult } from '../eval/responses.ts';

const envelope = (structuredContent: unknown, text = JSON.stringify(structuredContent)) => ({
  content: [{ type: 'text', text }],
  structuredContent,
});

test('exact JSON fallback projection preserves structured data, errors, metadata and raw result', () => {
  const structuredContent = Object.freeze({
    result: 'Café — 東京 ✓\n"quoted"\\path\t',
    outcomes: [{ state: 'unknown', reason: 'reconcile before retry' }],
    hasUnknownOutcome: true,
  });
  const content = Object.freeze([
    Object.freeze({ type: 'text', text: JSON.stringify(structuredContent) }),
  ]);
  const metadata = Object.freeze({ requestId: 'synthetic-request' });
  const raw = Object.freeze({
    content,
    structuredContent,
    isError: true,
    _meta: metadata,
    futureField: Object.freeze({ preserve: true }),
  });
  const originalBytes = JSON.stringify(raw);
  const projected = projectMcpToolResult(raw);
  assert.notEqual(projected, raw);
  assert.deepEqual(projected, {
    structuredContent,
    isError: true,
    _meta: metadata,
    futureField: raw.futureField,
  });
  assert.equal((projected as typeof raw).structuredContent, structuredContent);
  assert.equal((projected as typeof raw)._meta, metadata);
  assert.equal(JSON.stringify(raw), originalBytes);
  assert.equal(raw.content, content);
  assert.equal(projectMcpToolResult(projected), projected);
});

test('projection accepts an empty structured object and removes only content', () => {
  const raw = envelope({});
  assert.deepEqual(projectMcpToolResult(raw), { structuredContent: {} });
  assert.deepEqual(Object.keys(raw), ['content', 'structuredContent']);
});

const structuredContent = { first: 1, second: 2 };
const text = JSON.stringify(structuredContent);
const symbolMetadata = Symbol('metadata');
const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;

const unchanged: [string, unknown][] = [
  ['null result', null],
  ['undefined result', undefined],
  ['primitive result', 'text'],
  ['array result', []],
  ['missing content', { structuredContent }],
  ['missing structured data', { content: [{ type: 'text', text }] }],
  ['null structured data', envelope(null)],
  ['array structured data', envelope([1])],
  ['primitive structured data', envelope(1)],
  ['undefined structured data', envelope(undefined)],
  ['nonarray content', { structuredContent, content: { type: 'text', text } }],
  ['empty content', { structuredContent, content: [] }],
  [
    'multiple text blocks',
    {
      structuredContent,
      content: [
        { type: 'text', text },
        { type: 'text', text },
      ],
    },
  ],
  ['null content block', { structuredContent, content: [null] }],
  ['primitive content block', { structuredContent, content: [text] }],
  ['array content block', { structuredContent, content: [['text', text]] }],
  ['nontext block', { structuredContent, content: [{ type: 'image', text }] }],
  ['missing text', { structuredContent, content: [{ type: 'text' }] }],
  ['nonstring text', { structuredContent, content: [{ type: 'text', text: 42 }] }],
  ['different data', envelope(structuredContent, '{"first":1,"second":3}')],
  ['equivalent whitespace', envelope(structuredContent, '{ "first": 1, "second": 2 }')],
  ['equivalent key ordering', envelope(structuredContent, '{"second":2,"first":1}')],
  ['equivalent Unicode escape', envelope({ name: 'é' }, '{"name":"\\u00e9"}')],
  ['block annotations', { structuredContent, content: [{ type: 'text', text, annotations: {} }] }],
  ['block metadata', { structuredContent, content: [{ type: 'text', text, _meta: {} }] }],
  [
    'unknown block key',
    { structuredContent, content: [{ type: 'text', text, futureField: true }] },
  ],
  [
    'enumerable symbol block key',
    { structuredContent, content: [{ type: 'text', text, [symbolMetadata]: true }] },
  ],
  [
    'inherited structured data',
    Object.assign(Object.create({ structuredContent }), { content: [{ type: 'text', text }] }),
  ],
  [
    'inherited content',
    Object.assign(Object.create({ content: [{ type: 'text', text }] }), { structuredContent }),
  ],
  ['inherited block keys', { structuredContent, content: [Object.create({ type: 'text', text })] }],
  [
    'inherited type plus other own key',
    {
      structuredContent,
      content: [Object.assign(Object.create({ type: 'text' }), { text, annotations: {} })],
    },
  ],
  [
    'unserializable cyclic data',
    { structuredContent: cyclic, content: [{ type: 'text', text: '{}' }] },
  ],
];

for (const [name, value] of unchanged)
  test(`projection conservatively retains ${name}`, () => {
    assert.equal(projectMcpToolResult(value), value);
  });
