import assert from 'node:assert/strict';
import test from 'node:test';
import { COMBINED_GMAIL_CASE, GMAIL_CASES, getGmailCase, selectGmailCases } from '../eval/cases.ts';

test('independent Gmail catalogue selects six stable cases and preserves legacy default', () => {
  assert.deepEqual(
    selectGmailCases().map((entry) => entry.id),
    ['read-search', 'reply', 'attachment', 'labels', 'pagination', 'failure'],
  );
  assert.equal(getGmailCase(), COMBINED_GMAIL_CASE);
  assert.deepEqual(
    selectGmailCases('reply,labels').map((entry) => entry.id),
    ['reply', 'labels'],
  );
  assert.deepEqual(selectGmailCases('combined'), [COMBINED_GMAIL_CASE]);
  assert.ok(
    GMAIL_CASES.every(
      (entry) => entry.version === (['pagination', 'failure'].includes(entry.id) ? 2 : 1),
    ),
  );
  for (const invalid of ['', 'reply,reply', 'all,reply', 'read', ' reply', 'reply,'])
    assert.throws(() => selectGmailCases(invalid));
  assert.throws(() => getGmailCase('untrusted'));
});

test('case mutation policies permit only their independently requested work', () => {
  for (const id of ['read-search', 'attachment', 'pagination', 'failure'])
    assert.deepEqual(getGmailCase(id).policy, { expectedSends: 0, allowedMutations: [] });
  const reply = getGmailCase('reply').policy;
  assert.equal(reply.expectedSends, 1);
  assert.ok(reply.allowedMutations.includes('gmail/v1/users.messages.send'));
  assert.ok(!reply.allowedMutations.some((path) => path.endsWith('.modify')));
  const labels = getGmailCase('labels').policy;
  assert.equal(labels.expectedSends, 0);
  assert.deepEqual(labels.allowedMutations, [
    'gmail/v1/users.messages.modify',
    'gmail/v1/users.threads.modify',
  ]);
});
