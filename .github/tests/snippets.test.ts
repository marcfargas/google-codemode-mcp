import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundledSnippets, validateSnippets, validateSnippetInput } from '../../src/snippets.ts';

test('deployment snippet metadata validates inputs, identifiers, services and tool collisions', () => {
  const [snippet] = validateSnippets(bundledSnippets);
  validateSnippetInput(snippet, {});
  assert.throws(() => validateSnippetInput(snippet, { maxResults: 0 }));
  assert.throws(() => validateSnippets([{ ...snippet, tool: { name: 'execute' } }]));
  assert.throws(() => validateSnippets([{ ...snippet, services: ['drive/v3'] }]));
  assert.throws(() => validateSnippets([snippet, snippet]));
  assert.ok(Object.isFrozen(snippet.inputSchema));
});
