import { getArtifactCase, selectArtifactCases } from './artifacts.ts';
import { getDriveCase, selectDriveCases } from './drive.ts';
import { getMediaCase, selectMediaCases } from './media.ts';
import type { MechanismPolicy } from './mechanisms.ts';

export type GmailCaseId =
  | 'combined'
  | 'read-search'
  | 'reply'
  | 'attachment'
  | 'labels'
  | 'pagination'
  | 'failure'
  | 'selective-labels';

export interface GmailCase {
  id: GmailCaseId;
  title: string;
  version: number;
  policy: MechanismPolicy;
}

const replyMutations = [
  'gmail/v1/users.messages.send',
  'gmail/v1/users.drafts.create',
  'gmail/v1/users.drafts.update',
  'gmail/v1/users.drafts.send',
  'gmail/v1/users.drafts.delete',
] as const;
const labelMutations = ['gmail/v1/users.messages.modify', 'gmail/v1/users.threads.modify'] as const;
const readOnly: MechanismPolicy = { expectedSends: 0, allowedMutations: [] };

/** Fresh campaigns select these independent cases; combined is retained for old runs. */
export const GMAIL_CASES: readonly GmailCase[] = [
  { id: 'read-search', version: 1, title: 'Find and read an email', policy: readOnly },
  {
    id: 'reply',
    version: 1,
    title: 'Reply in the existing conversation',
    policy: { expectedSends: 1, allowedMutations: replyMutations },
  },
  { id: 'attachment', version: 1, title: 'Download an attachment exactly', policy: readOnly },
  {
    id: 'labels',
    version: 1,
    title: 'Apply an existing label',
    policy: { expectedSends: 0, allowedMutations: labelMutations },
  },
  { id: 'pagination', version: 2, title: 'Read every page of a search', policy: readOnly },
  { id: 'failure', version: 2, title: 'Handle a missing email safely', policy: readOnly },
];

/** Explicit-only unused composition; excluded from validation `all`. */
export const GMAIL_EVALUATION_CASES: readonly GmailCase[] = [
  {
    id: 'selective-labels',
    version: 1,
    title: 'Select messages by current body facts',
    policy: {
      expectedSends: 0,
      allowedMutations: [...labelMutations, 'gmail/v1/users.messages.batchModify'],
    },
  },
];

export const COMBINED_GMAIL_CASE: GmailCase = {
  id: 'combined',
  version: 1,
  title: 'Legacy combined Gmail task',
  policy: {
    expectedSends: 1,
    allowedMutations: [...replyMutations, ...labelMutations],
  },
};

export function getGmailCase(id: string = 'combined'): GmailCase {
  const selected = [COMBINED_GMAIL_CASE, ...GMAIL_CASES, ...GMAIL_EVALUATION_CASES].find(
    (entry) => entry.id === id,
  );
  if (!selected) throw new Error(`Unknown Gmail case: ${id}`);
  return selected;
}

export function selectGmailCases(selection = 'all'): GmailCase[] {
  const ids = selection === 'all' ? GMAIL_CASES.map((entry) => entry.id) : selection.split(',');
  if (!ids.length || ids.some((id) => !id || id.trim() !== id) || new Set(ids).size !== ids.length)
    throw new Error('Invalid Gmail case selection');
  return ids.map(getGmailCase);
}

/** Shared dispatch preserves each service's defaults and validation. */
export function getCase(profile: string, id?: string) {
  switch (profile) {
    case 'gmail':
      return getGmailCase(id);
    case 'drive':
      return getDriveCase(id);
    case 'artifacts':
      return getArtifactCase(id);
    case 'media':
      return getMediaCase(id);
    default:
      throw new Error('Unsupported suite profile');
  }
}
export function selectCases(profile: string, selection = 'all') {
  switch (profile) {
    case 'gmail':
      return selectGmailCases(selection);
    case 'drive':
      return selectDriveCases(selection);
    case 'artifacts':
      return selectArtifactCases(selection);
    case 'media':
      return selectMediaCases(selection);
    default:
      throw new Error('Unsupported suite profile');
  }
}
