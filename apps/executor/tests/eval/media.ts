import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { MechanismPolicy } from './mechanisms.ts';
import type { McpEvent } from './server.ts';

export const MEDIA_RESOURCE =
  'skill://google-codemode-mcp/google-workspace/references/media-transfers.md';
export const MEDIA_CASES = [
  {
    id: 'gmail-to-drive',
    version: 1,
    policy: {
      expectedSends: 0,
      allowedMutations: ['drive/v3/files.create'],
      requiredResourcesBeforeExecution: [MEDIA_RESOURCE],
    },
  },
  {
    id: 'drive-to-gmail',
    version: 1,
    policy: {
      expectedSends: 0,
      allowedMutations: ['gmail/v1/users.drafts.create'],
      requiredResourcesBeforeExecution: [MEDIA_RESOURCE],
    },
  },
] as const;
export type MediaCaseId = (typeof MEDIA_CASES)[number]['id'];
export function getMediaCase(id = 'gmail-to-drive'): {
  id: MediaCaseId;
  version: number;
  policy: MechanismPolicy;
} {
  const item = MEDIA_CASES.find((item) => item.id === id);
  if (!item) throw new Error('Unknown media case');
  return item;
}
export function selectMediaCases(selection = 'all') {
  const ids = selection === 'all' ? MEDIA_CASES.map((item) => item.id) : selection.split(',');
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error('Invalid media case selection');
  return ids.map(getMediaCase);
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export interface MediaExpected {
  profile: 'media';
  caseId: MediaCaseId;
  marker: string;
  name: string;
  mimeType: string;
  sha256: string;
  bytes: number;
  subject: string;
  recipient: string;
  folderId?: string;
  sourceMessageId?: string;
  sourceDraftId?: string;
  sourceDriveId?: string;
  sourceRawSha256?: string;
  sourceMetadata?: Record<string, unknown>;
  exportMimeType?: string;
  initialDraftIds: string[];
}
export interface MediaObservation {
  complete: boolean;
  sourceUnchanged: boolean;
  targets: {
    id: string;
    name: string;
    mimeType: string;
    parents: string[];
    sha256: string;
    bytes: number;
  }[];
  drafts: {
    id: string;
    messageId: string;
    subject: string;
    to: string;
    attachments: { name: string; mimeType: string; sha256: string; bytes: number }[];
  }[];
  unexpectedDraftIds: string[];
}
export function gradeMedia(
  expected: MediaExpected,
  observation: MediaObservation | null,
  files: Record<string, string>,
  audit: McpEvent[] | undefined,
) {
  const criteria: { id: string; status: 'pass' | 'fail' | 'unknown'; evidence: string }[] = [];
  const add = (id: string, good: boolean | null, evidence: string) =>
    criteria.push({ id, status: good === null ? 'unknown' : good ? 'pass' : 'fail', evidence });
  let answer: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(Buffer.from(files['answer.json'] ?? '', 'base64').toString('utf8'));
    if (object(parsed)) answer = parsed;
  } catch {
    /* invalid answer stays failed */
  }
  const executions = Array.isArray(audit)
    ? audit.filter((event) => event.method === 'tools/call' && event.params?.name !== 'describe')
    : null;
  let complete = !!executions?.length;
  const outcomes: Record<string, any>[] = [];
  for (const execution of executions ?? []) {
    const receipt = execution.response?.result?.structuredContent;
    if (
      execution.status < 200 ||
      execution.status >= 300 ||
      execution.response?.error ||
      execution.response?.result?.isError ||
      !object(receipt) ||
      receipt.outcomesComplete !== true ||
      typeof receipt.hasUnknownOutcome !== 'boolean' ||
      !Array.isArray(receipt.outcomes)
    ) {
      complete = false;
      continue;
    }
    for (const outcome of receipt.outcomes) {
      if (
        !object(outcome) ||
        typeof outcome.path !== 'string' ||
        typeof outcome.mutation !== 'boolean' ||
        !['not_dispatched', 'rejected', 'acknowledged', 'unknown'].includes(outcome.outcome)
      )
        complete = false;
      else outcomes.push(outcome);
    }
    if (
      receipt.hasUnknownOutcome !==
      receipt.outcomes.some((item: any) => item?.mutation && item?.outcome === 'unknown')
    )
      complete = false;
  }
  const mutationPath =
    expected.caseId === 'gmail-to-drive' ? 'drive/v3/files.create' : 'gmail/v1/users.drafts.create';
  const mutations = outcomes.filter((outcome) => outcome.mutation);
  add(
    'media_mutation_ledger',
    complete
      ? mutations.length === 1 &&
          mutations[0].path === mutationPath &&
          mutations[0].outcome === 'acknowledged'
      : null,
    'Exactly one acknowledged permitted native mutation in complete trusted ledgers; self-reported outcomes are ignored.',
  );
  const createdId = mutations.length === 1 ? mutations[0].resourceId : undefined;
  const observedId =
    expected.caseId === 'gmail-to-drive' ? observation?.targets[0]?.id : observation?.drafts[0]?.id;
  add(
    'media_created_identity',
    !complete || !observation?.complete || (mutations.length === 1 && typeof createdId !== 'string')
      ? null
      : mutations.length === 1 && createdId === observedId,
    'The trusted native create identity must equal the independently observed target; answer IDs never authorize cleanup.',
  );
  const read =
    expected.caseId === 'gmail-to-drive'
      ? outcomes.some(
          (outcome) =>
            outcome.path === 'gmail/v1/users.messages.get' &&
            outcome.resourceId === expected.sourceMessageId &&
            !outcome.mutation &&
            outcome.outcome === 'acknowledged',
        )
      : outcomes.some(
          (outcome) =>
            outcome.path === `drive/v3/files.${expected.exportMimeType ? 'export' : 'get'}` &&
            outcome.resourceId === expected.sourceDriveId &&
            !outcome.mutation &&
            outcome.outcome === 'acknowledged',
        );
  add(
    'media_source_read',
    complete ? read : null,
    'An acknowledged native read must identify the owned source; outputs cannot substitute for that read.',
  );
  add(
    'media_files_only',
    same(Object.keys(files).sort(), ['answer.json']),
    'Only the requested UTF-8 answer.json is written.',
  );
  add(
    'media_readback',
    observation === null ? null : observation.complete,
    'Independent Google readback completed.',
  );
  add(
    'media_source_preserved',
    observation === null || !observation.complete ? null : observation.sourceUnchanged,
    'Original source metadata/content and source draft remain unchanged.',
  );
  if (!observation?.complete) {
    add('media_transfer', null, 'Independent target evidence unavailable.');
    add(
      'media_answer',
      !!answer && Object.keys(answer).length === 1,
      'Answer requires the actual independently observed created identity.',
    );
    return criteria;
  }
  if (expected.caseId === 'gmail-to-drive') {
    const target = observation.targets[0];
    add(
      'media_transfer',
      observation.targets.length === 1 &&
        !!target &&
        target.name === expected.name &&
        target.mimeType.split(';')[0].toLowerCase() === expected.mimeType &&
        same(target.parents, [expected.folderId]) &&
        target.sha256 === expected.sha256 &&
        target.bytes === expected.bytes &&
        observation.drafts.length === 0 &&
        observation.unexpectedDraftIds.length === 0,
      'Exactly one transformed file in the chosen folder, exact independently decoded bytes/MIME; no new drafts.',
    );
    add(
      'media_answer',
      !!target && !!answer && same(Object.keys(answer), ['fileId']) && answer.fileId === target.id,
      'answer.json must identify the independently observed created file.',
    );
  } else {
    const draft = observation.drafts[0];
    const attachment = draft?.attachments[0];
    add(
      'media_transfer',
      observation.drafts.length === 1 &&
        !!draft &&
        draft.subject === expected.subject &&
        draft.to.toLowerCase() === expected.recipient.toLowerCase() &&
        draft.attachments.length === 1 &&
        !!attachment &&
        attachment.name === expected.name &&
        attachment.mimeType.split(';')[0].toLowerCase() === expected.mimeType &&
        attachment.sha256 === expected.sha256 &&
        attachment.bytes === expected.bytes &&
        observation.targets.length === 0 &&
        observation.unexpectedDraftIds.length === 0,
      'Exactly one unsent draft to the test account with exact attachment bytes, filename, MIME and subject; no new Drive files.',
    );
    add(
      'media_answer',
      !!draft && !!answer && same(Object.keys(answer), ['draftId']) && answer.draftId === draft.id,
      'answer.json must identify the independently observed created draft.',
    );
  }
  return criteria;
}

interface Part {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}
const parts = (part: Part): Part[] => [part, ...(part.parts ?? []).flatMap(parts)];
function header(part: Part, name: string) {
  return (part.headers ?? [])
    .filter((h) => h.name.toLowerCase() === name.toLowerCase())
    .map((h) => h.value)
    .join(', ');
}
function decode(data: string) {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(data) || data.length % 4 === 1)
    throw new Error('Malformed Gmail bytes');
  const bytes = Buffer.from(data, 'base64url');
  if (bytes.toString('base64url') !== data.replace(/=+$/, ''))
    throw new Error('Noncanonical Gmail bytes');
  return bytes;
}

/** Trusted test MIME construction; actor uses the product's separately implemented helper. */
export function fixtureMime(options: {
  to: string;
  subject: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  marker: string;
}) {
  const boundary = `fixture_${randomUUID().replaceAll('-', '')}`;
  const encoded =
    Buffer.from(options.bytes)
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? '';
  return Buffer.from(
    [
      `To: ${options.to}`,
      `From: ${options.to}`,
      `Subject: ${options.subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'Controlled disposable fixture ' + options.marker,
      `--${boundary}`,
      `Content-Type: ${options.mimeType}`,
      `Content-Disposition: attachment; filename="${options.name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      encoded,
      `--${boundary}--`,
      '',
    ].join('\r\n'),
  ).toString('base64url');
}

export interface MediaFixture {
  expected: MediaExpected;
  prompt: string;
  observe(files?: Record<string, string>, audit?: McpEvent[]): Promise<MediaObservation>;
  cleanup(): Promise<{ failures: string[]; unknownMutations: Record<string, unknown>[] }>;
}
export async function prepareMediaFixture(options: {
  accessToken: string;
  expectedUser: string;
  caseId?: string;
  exportSource?: boolean;
  byteLength?: number;
  onEvent?: (manifest: unknown) => Promise<unknown> | void;
}): Promise<MediaFixture> {
  const selected = getMediaCase(options.caseId);
  if (!/^[^\s@<>\r\n]+@[^\s@<>\r\n]+$/.test(options.expectedUser))
    throw new Error('Invalid media test account');
  const marker = `codemode-media-${randomUUID()}`;
  let bytes = Buffer.concat([
    Buffer.from(`Disposable composition ${marker}\n`),
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    randomBytes(64),
    Buffer.from('\n'),
  ]);
  if (options.byteLength !== undefined) {
    if (
      !Number.isSafeInteger(options.byteLength) ||
      options.byteLength < 1 ||
      options.byteLength > 1048576
    )
      throw new Error('Invalid controlled media fixture size');
    bytes = Buffer.from(Array.from({ length: options.byteLength }, (_, index) => index % 251));
  }
  const knownFiles: string[] = [];
  const knownDrafts: string[] = [];
  const actorFiles = new Set<string>();
  const actorDrafts = new Set<string>();
  const actorWrites = new Map<string, Record<string, any>>();
  const writes: Record<string, any>[] = [];
  let cleaned: unknown;
  const emit = () =>
    options.onEvent?.({
      marker,
      fileIds: [...new Set([...knownFiles, ...actorFiles])],
      draftIds: [...new Set([...knownDrafts, ...actorDrafts])],
      actorWrites: [...actorWrites.values()],
      writes: structuredClone(writes),
      cleanup: cleaned,
    });
  async function request(path: string, init?: RequestInit, write = false) {
    const entry = write
      ? {
          path,
          method: init?.method ?? 'GET',
          outcome: 'attempting',
          unreconciled: !['DELETE', 'PATCH'].includes(init?.method ?? 'GET'),
        }
      : undefined;
    if (entry) {
      writes.push(entry);
      await emit();
    }
    let response: Response;
    try {
      response = await fetch(`https://www.googleapis.com/${path}`, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          Authorization: `Bearer ${options.accessToken}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      if (entry) {
        entry.outcome = 'unknown';
        await emit();
      }
      throw new Error('Media fixture transport failed; no retry');
    }
    if (entry) {
      entry.outcome = response.ok
        ? 'acknowledged'
        : response.status >= 400 && response.status < 500 && response.status !== 408
          ? 'rejected'
          : 'unknown';
      await emit();
    }
    if (entry?.outcome === 'rejected') {
      entry.unreconciled = false;
      await emit();
    }
    if (!response.ok) throw new Error(`Media fixture HTTP ${response.status}; no retry`);
    return response;
  }
  async function create(path: string, init: RequestInit, ids: string[]) {
    const response = await request(path, init, true);
    let value: any;
    try {
      value = await response.json();
    } catch {
      throw new Error('Acknowledged fixture create identity unreadable; inspect manifest');
    }
    if (typeof value.id !== 'string' || !value.id)
      throw new Error('Acknowledged fixture create has no identity; inspect manifest');
    ids.push(value.id);
    writes.at(-1)!.id = value.id;
    writes.at(-1)!.unreconciled = false;
    await emit();
    return value;
  }
  async function jsonRead(path: string): Promise<Record<string, any>> {
    const response = await request(path);
    return response.status === 204 ? {} : (response.json() as Promise<Record<string, any>>);
  }
  async function draftIds() {
    const ids: string[] = [];
    let token = '';
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const q = new URLSearchParams({ maxResults: '100', ...(token ? { pageToken: token } : {}) });
      const data = await jsonRead(`gmail/v1/users/me/drafts?${q}`);
      if (!Array.isArray(data.drafts) && data.drafts !== undefined)
        throw new Error('Invalid draft list');
      for (const draft of data.drafts ?? []) {
        if (typeof draft.id !== 'string') throw new Error('Invalid draft identity');
        ids.push(draft.id);
      }
      if (!data.nextPageToken) return [...new Set(ids)].sort();
      if (typeof data.nextPageToken !== 'string' || seen.has(data.nextPageToken))
        throw new Error('Invalid draft continuation');
      token = data.nextPageToken;
      seen.add(token);
    }
    throw new Error('Draft listing exceeds safety bound');
  }
  async function attachmentBytes(messageId: string, part: Part) {
    let body = part.body;
    if (body?.attachmentId)
      body = await jsonRead(
        `gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(body.attachmentId)}`,
      );
    if (typeof body?.data !== 'string') throw new Error('Attachment bytes absent');
    const value = decode(body.data);
    if (body.size !== undefined && body.size !== value.length)
      throw new Error('Attachment byte size differs');
    return value;
  }
  async function ownedTargets(folderId?: string) {
    const q = new URLSearchParams({
      q: `trashed = false and (name contains '${marker}'${folderId ? ` or '${folderId}' in parents` : ''})`,
      fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,parents)',
      pageSize: '100',
    });
    const result = await jsonRead(`drive/v3/files?${q}`);
    if (
      result.nextPageToken ||
      result.incompleteSearch === true ||
      (result.files !== undefined && !Array.isArray(result.files))
    )
      throw new Error('Target inventory incomplete');
    return (result.files ?? []).filter((file: any) => !knownFiles.includes(file.id));
  }
  const initialDraftIds = await draftIds();
  const expected: MediaExpected = {
    profile: 'media',
    caseId: selected.id,
    marker,
    name: `${marker}-renamed.bin`,
    mimeType: 'application/octet-stream',
    sha256: hash(bytes),
    bytes: bytes.length,
    subject: `Transfer ${marker}`,
    recipient: options.expectedUser,
    initialDraftIds,
  };
  const cleanup = async () => {
    const failures: string[] = [];
    for (const id of actorFiles) if (!knownFiles.includes(id)) knownFiles.push(id);
    for (const id of actorDrafts) if (!knownDrafts.includes(id)) knownDrafts.push(id);
    // Association is observation evidence, never proof that the trial created it.
    try {
      if (
        (await ownedTargets(expected.folderId)).some((file: any) => !knownFiles.includes(file.id))
      )
        failures.push('unowned-target-associated');
    } catch {
      failures.push('target-inventory');
    }
    try {
      for (const id of (await draftIds()).filter(
        (id) => !initialDraftIds.includes(id) && !knownDrafts.includes(id),
      )) {
        const draft = await jsonRead(
          `gmail/v1/users/me/drafts/${encodeURIComponent(id)}?format=full`,
        );
        if (header(draft.message?.payload ?? {}, 'subject').includes(marker))
          failures.push('unowned-draft-associated');
      }
    } catch {
      failures.push('draft-inventory');
    }
    for (const id of [...knownDrafts].reverse())
      try {
        await request(
          `gmail/v1/users/me/drafts/${encodeURIComponent(id)}`,
          { method: 'DELETE' },
          true,
        );
      } catch {
        failures.push(`draft:${id}`);
      }
    for (const id of [...knownFiles].reverse())
      try {
        const metadata = await jsonRead(`drive/v3/files/${encodeURIComponent(id)}?fields=mimeType`);
        if (typeof metadata.mimeType !== 'string') throw new Error('Cleanup file type unavailable');
        if (metadata.mimeType === 'application/vnd.google-apps.folder') {
          const children = await jsonRead(
            'drive/v3/files?' +
              new URLSearchParams({
                q: `'${id}' in parents`,
                fields: 'files(id),nextPageToken,incompleteSearch',
                pageSize: '100',
              }),
          );
          if (
            (children.files !== undefined && !Array.isArray(children.files)) ||
            (children.files ?? []).length ||
            children.nextPageToken ||
            children.incompleteSearch === true ||
            [...writes, ...actorWrites.values()].some(
              (entry) =>
                ['unknown', 'attempting'].includes(entry.outcome) || entry.unreconciled === true,
            )
          ) {
            failures.push(`folder:${id}:preserved-unverified-children`);
            continue;
          }
        }
        await request(`drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE' }, true);
      } catch {
        failures.push(`file:${id}`);
      }
    const result = {
      failures,
      unknownMutations: [...writes, ...actorWrites.values()].filter(
        (entry) => ['unknown', 'attempting'].includes(entry.outcome) || entry.unreconciled === true,
      ),
    };
    cleaned = result;
    await emit();
    return result;
  };
  try {
    const gmail = await jsonRead('gmail/v1/users/me/profile');
    const drive = await jsonRead('drive/v3/about?fields=user(emailAddress)');
    if (
      gmail.emailAddress?.toLowerCase() !== options.expectedUser.toLowerCase() ||
      drive.user?.emailAddress?.toLowerCase() !== options.expectedUser.toLowerCase()
    )
      throw new Error('Media test account mismatch');
    if (selected.id === 'gmail-to-drive') {
      const folder = await create(
        'drive/v3/files?fields=id',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `${marker}-folder`,
            mimeType: 'application/vnd.google-apps.folder',
          }),
        },
        knownFiles,
      );
      expected.folderId = folder.id;
      const draft = await create(
        'gmail/v1/users/me/drafts',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              raw: fixtureMime({
                to: options.expectedUser,
                subject: `Source ${marker}`,
                name: `${marker}-original.bin`,
                mimeType: expected.mimeType,
                bytes,
                marker,
              }),
            },
          }),
        },
        knownDrafts,
      );
      expected.sourceDraftId = draft.id;
      expected.sourceMessageId = draft.message?.id;
      if (!expected.sourceMessageId) throw new Error('Fixture draft message identity absent');
      const raw = await jsonRead(
        `gmail/v1/users/me/messages/${encodeURIComponent(expected.sourceMessageId)}?format=raw`,
      );
      if (typeof raw.raw !== 'string') throw new Error('Source raw unavailable');
      expected.sourceRawSha256 = hash(decode(raw.raw));
      const message = await jsonRead(
        `gmail/v1/users/me/messages/${encodeURIComponent(expected.sourceMessageId)}?format=full`,
      );
      const attachment = parts(message.payload ?? {}).find((part) => !!part.filename);
      if (
        !attachment ||
        hash(await attachmentBytes(expected.sourceMessageId, attachment)) !== expected.sha256
      )
        throw new Error('Source attachment baseline mismatch');
    } else {
      const boundary = `fixture_${randomUUID().replaceAll('-', '')}`;
      const native = options.exportSource === true;
      if (native) {
        bytes = Buffer.from(`<html><body><p>${marker}</p></body></html>`);
        expected.exportMimeType = 'text/plain';
        expected.name = `${marker}-export.txt`;
        expected.mimeType = 'text/plain';
      }
      const metadata = {
        name: `${marker}-source${native ? '' : '.bin'}`,
        mimeType: native ? 'application/vnd.google-apps.document' : expected.mimeType,
        description: marker,
      };
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${native ? 'text/html' : expected.mimeType}\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const file = await create(
        'upload/drive/v3/files?uploadType=multipart&fields=id',
        {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body,
        },
        knownFiles,
      );
      expected.sourceDriveId = file.id;
      expected.sourceMetadata = await jsonRead(
        `drive/v3/files/${encodeURIComponent(file.id)}?fields=id,name,mimeType,parents,description,trashed`,
      );
      const actual = new Uint8Array(
        await (
          await request(
            `drive/v3/files/${encodeURIComponent(file.id)}${native ? '/export?mimeType=text%2Fplain' : '?alt=media'}`,
          )
        ).arrayBuffer(),
      );
      if (native && !Buffer.from(actual).toString('utf8').includes(marker))
        throw new Error('Native export baseline content absent');
      if (!native && hash(actual) !== hash(bytes)) throw new Error('Drive source baseline differs');
      expected.sha256 = hash(actual);
      expected.bytes = actual.length;
    }
    await emit();
    const prompt =
      selected.id === 'gmail-to-drive'
        ? `Read the attachment on Gmail message ${JSON.stringify(expected.sourceMessageId)}. In Code Mode transform its filename to ${JSON.stringify(expected.name)} and upload its exact original bytes and MIME type to Drive folder ${JSON.stringify(expected.folderId)}. Preserve the Gmail source and create exactly one Drive file, no other remote changes. Read the deployment's advanced media-transfer skill resource before executing. Write only answer.json with exactly {"fileId":"the new file ID"}.`
        : `Read ${expected.exportMimeType ? 'and export as ' + expected.exportMimeType : 'the original bytes of'} Drive file ${JSON.stringify(expected.sourceDriveId)}. In Code Mode compose a Gmail draft to ${JSON.stringify(expected.recipient)} with subject ${JSON.stringify(expected.subject)} and exactly one attachment named ${JSON.stringify(expected.name)} preserving the exact ${expected.mimeType} bytes. Do not send the draft or change the Drive source. Read the deployment's advanced media-transfer skill resource before executing. Write only answer.json with exactly {"draftId":"the new draft ID"}.`;
    const observe = async (
      files?: Record<string, string>,
      audit?: McpEvent[],
    ): Promise<MediaObservation> => {
      for (const [index, event] of (audit ?? []).entries()) {
        if (event.method !== 'tools/call' || event.params?.name === 'describe') continue;
        const key = String(event.startedOrdinal ?? index);
        const receipt = event.response?.result?.structuredContent;
        const valid =
          event.status >= 200 &&
          event.status < 300 &&
          !event.response?.error &&
          !event.response?.result?.isError &&
          object(receipt) &&
          receipt.outcomesComplete === true &&
          Array.isArray(receipt.outcomes);
        if (!valid) {
          actorWrites.set(key + ':execution', {
            path: 'execute',
            outcome: 'unknown',
            unreconciled: true,
          });
          continue;
        }
        actorWrites.delete(key + ':execution');
        for (const [ordinal, outcome] of receipt.outcomes.entries()) {
          if (!object(outcome) || typeof outcome.mutation !== 'boolean') {
            actorWrites.set(key + ':' + ordinal, {
              path: 'execute',
              outcome: 'unknown',
              unreconciled: true,
            });
            continue;
          }
          if (!outcome.mutation) continue;
          if (!['drive/v3/files.create', 'gmail/v1/users.drafts.create'].includes(outcome.path)) {
            actorWrites.set(key + ':' + ordinal, {
              path: outcome.path,
              outcome: outcome.outcome,
              unreconciled: !['not_dispatched', 'rejected'].includes(outcome.outcome),
            });
            continue;
          }
          const target = outcome.path === 'drive/v3/files.create' ? actorFiles : actorDrafts;
          const identity =
            typeof outcome.resourceId === 'string' &&
            /^[A-Za-z0-9_-]{1,256}$/.test(outcome.resourceId);
          if (outcome.outcome === 'acknowledged' && identity) target.add(outcome.resourceId);
          actorWrites.set(key + ':' + ordinal, {
            path: outcome.path,
            outcome: outcome.outcome,
            ...(identity ? { id: outcome.resourceId } : {}),
            unreconciled: outcome.outcome === 'acknowledged' && !identity,
          });
        }
      }
      await emit();
      const observation: MediaObservation = {
        complete: false,
        sourceUnchanged: false,
        targets: [],
        drafts: [],
        unexpectedDraftIds: [],
      };
      try {
        if (expected.sourceMessageId) {
          const raw = await jsonRead(
            `gmail/v1/users/me/messages/${encodeURIComponent(expected.sourceMessageId)}?format=raw`,
          );
          const source = await jsonRead(
            `gmail/v1/users/me/drafts/${encodeURIComponent(expected.sourceDraftId!)}?format=minimal`,
          );
          observation.sourceUnchanged =
            typeof raw.raw === 'string' &&
            hash(decode(raw.raw)) === expected.sourceRawSha256 &&
            source.message?.id === expected.sourceMessageId;
        } else {
          const id = encodeURIComponent(expected.sourceDriveId!);
          const metadata = await jsonRead(
            `drive/v3/files/${id}?fields=id,name,mimeType,parents,description,trashed`,
          );
          const actual = new Uint8Array(
            await (
              await request(
                `drive/v3/files/${id}${expected.exportMimeType ? '/export?mimeType=' + encodeURIComponent(expected.exportMimeType) : '?alt=media'}`,
              )
            ).arrayBuffer(),
          );
          observation.sourceUnchanged =
            same(metadata, expected.sourceMetadata) &&
            hash(actual) === expected.sha256 &&
            actual.length === expected.bytes;
        }
        let answer: Record<string, any> = {};
        try {
          const value = JSON.parse(
            Buffer.from(files?.['answer.json'] ?? '', 'base64').toString('utf8'),
          );
          if (object(value)) answer = value;
        } catch {
          /* independent readback still observes other effects */
        }
        const targets = await ownedTargets(expected.folderId);
        for (const id of actorFiles)
          if (!targets.some((file: any) => file.id === id))
            targets.push(
              await jsonRead(
                'drive/v3/files/' +
                  encodeURIComponent(id) +
                  '?fields=id,name,mimeType,parents,trashed',
              ),
            );
        if (
          expected.caseId === 'gmail-to-drive' &&
          typeof answer.fileId === 'string' &&
          /^[A-Za-z0-9_-]{1,256}$/.test(answer.fileId) &&
          !knownFiles.includes(answer.fileId) &&
          !targets.some((file: any) => file.id === answer.fileId)
        ) {
          const direct = await jsonRead(
            'drive/v3/files/' +
              encodeURIComponent(answer.fileId) +
              '?fields=id,name,mimeType,parents,trashed',
          );
          if (
            typeof direct.name === 'string' &&
            direct.name.includes(marker) &&
            direct.trashed === false
          )
            targets.push(direct);
        }
        for (const file of targets) {
          if (
            typeof file.mimeType === 'string' &&
            file.mimeType.startsWith('application/vnd.google-apps.')
          ) {
            // A known wrong target format is a scored task failure, not a failed blob read.
            observation.targets.push({
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              parents: [...(file.parents ?? [])].sort(),
              sha256: '',
              bytes: 0,
            });
            continue;
          }
          const actual = new Uint8Array(
            await (
              await request(`drive/v3/files/${encodeURIComponent(file.id)}?alt=media`)
            ).arrayBuffer(),
          );
          observation.targets.push({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            parents: [...(file.parents ?? [])].sort(),
            sha256: hash(actual),
            bytes: actual.length,
          });
        }
        const listedIds = [...new Set([...(await draftIds()), ...actorDrafts])];
        if (
          expected.caseId === 'drive-to-gmail' &&
          typeof answer.draftId === 'string' &&
          /^[A-Za-z0-9_-]{1,256}$/.test(answer.draftId) &&
          !listedIds.includes(answer.draftId)
        )
          listedIds.push(answer.draftId);
        const newIds = listedIds.filter(
          (id) => !expected.initialDraftIds.includes(id) && id !== expected.sourceDraftId,
        );
        for (const id of newIds) {
          const draft = await jsonRead(
            `gmail/v1/users/me/drafts/${encodeURIComponent(id)}?format=full`,
          );
          const payload = draft.message?.payload ?? {};
          const subject = header(payload, 'subject');
          if (!subject.includes(marker) && !actorDrafts.has(id)) {
            observation.unexpectedDraftIds.push(id);
            continue;
          }
          const attachments = [];
          for (const part of parts(payload).filter(
            (part) =>
              !!part.filename ||
              /^attachment(?:\s*;|\s*$)/i.test(header(part, 'content-disposition')),
          )) {
            const data = await attachmentBytes(draft.message.id, part);
            attachments.push({
              name: part.filename ?? '',
              mimeType: part.mimeType ?? '',
              sha256: hash(data),
              bytes: data.length,
            });
          }
          observation.drafts.push({
            id,
            messageId: draft.message.id,
            subject,
            to: header(payload, 'to'),
            attachments,
          });
        }
        observation.complete = true;
        await emit();
        return observation;
      } catch {
        return observation;
      }
    };
    return { expected, prompt, observe, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Deterministic live control uses the same public Code Mode interface as the actor. */
export function mediaControlProgram(expected: Pick<MediaExpected, 'caseId' | 'exportMimeType'>) {
  return expected.caseId === 'gmail-to-drive'
    ? `
const gmail=google.gmail({version:'v1'}); const drive=google.drive({version:'v3'});
const {data:message}=await gmail.users.messages.get({userId:'me',id:inputs.sourceMessageId,format:'full'});
function walk(part){return [part,...(part.parts??[]).flatMap(walk)];}
const selected=walk(message.payload).filter(part=>part.filename).map(part=>({...part,filename:inputs.name}));
if(selected.length!==1)throw new Error('Expected one fixture attachment');
const created=[];
for(const part of selected){const body=part.body.attachmentId?(await gmail.users.messages.attachments.get({userId:'me',messageId:inputs.sourceMessageId,id:part.body.attachmentId})).data:part.body;
created.push((await drive.files.create({requestBody:{name:part.filename,parents:[inputs.folderId]},media:{mimeType:part.mimeType,body:{encoding:'base64url',data:body.data,size:body.size}},fields:'id,name,mimeType,parents'})).data);}
return {fileId:created[0].id};`
    : `const drive=google.drive({version:'v3'}); const gmail=google.gmail({version:'v1'});
const {data:media}=await drive.files.${expected.exportMimeType ? 'export({fileId:inputs.sourceDriveId,mimeType:inputs.exportMimeType})' : "get({fileId:inputs.sourceDriveId,alt:'media'})"};
const raw=await snippets.run('composeMime',{to:inputs.recipient,subject:inputs.subject,text:'Disposable composition fixture',attachments:[{name:inputs.name,...media}]});
const {data:draft}=await gmail.users.drafts.create({userId:'me',requestBody:{message:{raw}}});
return {draftId:draft.id};`;
}
