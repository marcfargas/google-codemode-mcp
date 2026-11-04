import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export interface GmailCriterion {
  id: string;
  status: 'pass' | 'fail' | 'unknown';
  evidence: string;
}
export interface GmailWrite {
  operation: string;
  state: 'attempting' | 'acknowledged' | 'rejected' | 'unknown';
  id?: string;
}
export interface GmailManifest {
  run: string;
  subject: string;
  labelName: string;
  accountVerified: boolean;
  messageIds: string[];
  draftIds: string[];
  labelIds: string[];
  writes: GmailWrite[];
}
export interface GmailExpected {
  account: string;
  subject: string;
  sourceId: string;
  threadId: string;
  messageId: string;
  labelId: string;
  labelName: string;
  initialSourceLabels: string[];
  initialLabels: { id: string; name: string; type?: string }[];
  initialDraftIds: string[];
  historyId: string;
  confirmationCode: string;
  attachment: { filename: string; sha256: string; bytes: number; attachmentId: string };
}
export interface GmailObservedMessage {
  id: string;
  threadId: string;
  labels: string[];
  headers: Record<string, string[]>;
  plainText: string[];
  mimeComplete: boolean;
}
export interface GmailHistoryChange {
  kind: 'messageAdded' | 'messageDeleted' | 'labelsAdded' | 'labelsRemoved';
  id: string;
  threadId: string;
  labels: string[];
}
export interface GmailObservation {
  source: GmailObservedMessage | null;
  thread: GmailObservedMessage[];
  history: GmailHistoryChange[];
  labels: { id: string; name: string; type?: string }[];
  newDraftIds: string[];
  complete: boolean;
  errors: string[];
}
export interface GmailCleanup {
  failures: string[];
  unknownMutations: GmailWrite[];
}
export interface GmailFixture {
  prompt: string;
  expected: GmailExpected;
  manifest: GmailManifest;
  observe(): Promise<GmailObservation>;
  cleanup(): Promise<GmailCleanup>;
}
interface GoogleMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  payload?: MimePart;
}
interface MimePart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: MimePart[];
}
interface GoogleHistory {
  messagesAdded?: { message?: GoogleMessage }[];
  messagesDeleted?: { message?: GoogleMessage }[];
  labelsAdded?: { message?: GoogleMessage; labelIds?: string[] }[];
  labelsRemoved?: { message?: GoogleMessage; labelIds?: string[] }[];
}
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sorted = (values: string[]) => [...values].sort();
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function parts(root: MimePart | undefined): MimePart[] {
  return root ? [root, ...(root.parts ?? []).flatMap(parts)] : [];
}
function observed(message: GoogleMessage): GmailObservedMessage {
  const headers: Record<string, string[]> = {};
  for (const header of message.payload?.headers ?? []) {
    const name = header.name.toLowerCase();
    (headers[name] ??= []).push(header.value);
  }
  const text = parts(message.payload).filter(
    (part) => part.mimeType?.toLowerCase() === 'text/plain' && !part.filename,
  );
  return {
    id: message.id ?? '',
    threadId: message.threadId ?? '',
    labels: sorted(message.labelIds ?? []),
    headers,
    plainText: text
      .filter((part) => typeof part.body?.data === 'string')
      .map((part) => Buffer.from(part.body!.data!, 'base64url').toString('utf8')),
    mimeComplete: text.length > 0 && text.every((part) => typeof part.body?.data === 'string'),
  };
}
function header(message: GmailObservedMessage, name: string): string {
  return (message.headers[name] ?? []).join(', ').trim();
}
function addresses(value: string): string[] | null {
  // The fixture uses one simple ASCII address. Reject comments/groups/ambiguous lists.
  if (!value || /[\r\n;():]/.test(value)) return null;
  const result: string[] = [];
  for (const mailbox of value.split(',')) {
    const match = mailbox.trim().match(/^(?:[^<>]*<([^<>]+)>|([^<>\s]+))$/);
    const address = (match?.[1] ?? match?.[2] ?? '').trim().toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(address)) return null;
    result.push(address);
  }
  return result;
}
function normalizedText(value: string) {
  return value.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

/** Pure grader: only independent Google readback and captured local file bytes count. */
export function gradeGmail(
  expected: GmailExpected,
  observation: GmailObservation | null,
  files: Record<string, string>,
): GmailCriterion[] {
  const criteria: GmailCriterion[] = [];
  const add = (id: string, result: boolean | null, evidence: string) =>
    criteria.push({ id, status: result === null ? 'unknown' : result ? 'pass' : 'fail', evidence });
  const filename = expected.attachment.filename;
  const encoded = Object.hasOwn(files, filename) ? files[filename] : undefined;
  const bytes = typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : undefined;
  add(
    'attachment_file',
    !!bytes &&
      bytes.length === expected.attachment.bytes &&
      hash(bytes) === expected.attachment.sha256,
    bytes
      ? 'Captured file length and SHA-256 compared with fixture bytes.'
      : 'Expected file absent.',
  );
  add(
    'only_requested_file',
    equal(Object.keys(files).sort(), [filename]),
    'Output filenames compared.',
  );
  if (!observation) {
    for (const id of [
      'readback',
      'original_label',
      'one_reply',
      'reply_thread',
      'reply_headers',
      'reply_body',
      'no_extra_effects',
    ])
      add(id, null, 'Independent Gmail observation unavailable.');
    return criteria;
  }
  add(
    'readback',
    observation.complete,
    `Independent readback errors: ${observation.errors.length}.`,
  );
  const source = observation.source;
  add(
    'original_label',
    source
      ? source.id === expected.sourceId &&
          source.threadId === expected.threadId &&
          source.labels.includes(expected.labelId)
      : null,
    source ? 'Original message label membership checked.' : 'Original message unavailable.',
  );
  const replies = observation.thread.filter((message) => message.id !== expected.sourceId);
  const grouped = new Map<string, GmailObservedMessage[]>();
  for (const reply of replies) {
    const key = header(reply, 'message-id') || `missing:${reply.id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), reply]);
  }
  add(
    'one_reply',
    grouped.size === 1 &&
      [...grouped.values()].every(
        (group) => group.filter((reply) => reply.labels.includes('SENT')).length === 1,
      ),
    `Observed ${grouped.size} logical replies; sent representations counted independently.`,
  );
  const logicalReply = grouped.size === 1 ? [...grouped.values()][0] : [];
  add(
    'reply_thread',
    logicalReply.length > 0 && logicalReply.every((reply) => reply.threadId === expected.threadId),
    'Independent thread IDs checked.',
  );
  add(
    'reply_headers',
    logicalReply.length > 0 &&
      logicalReply.every((reply) => {
        const id = header(reply, 'message-id');
        const references: string[] = header(reply, 'references').match(/<[^<>\s]+>/g) ?? [];
        return (
          /^<[^<>\s]+>$/.test(id) &&
          id !== expected.messageId &&
          header(reply, 'in-reply-to') === expected.messageId &&
          references.includes(expected.messageId) &&
          equal(addresses(header(reply, 'to')), [expected.account.toLowerCase()]) &&
          equal(addresses(header(reply, 'from')), [expected.account.toLowerCase()]) &&
          !header(reply, 'cc') &&
          !header(reply, 'bcc') &&
          header(reply, 'subject') === `Re: ${expected.subject}`
        );
      }),
    'Reply identity, recipient, subject, In-Reply-To and References checked.',
  );
  add(
    'reply_body',
    logicalReply.length > 0 &&
      logicalReply.every(
        (reply) =>
          reply.mimeComplete &&
          reply.plainText.length === 1 &&
          normalizedText(reply.plainText[0]) === `Confirmed: ${expected.confirmationCode}`,
      ),
    'Decoded text/plain body compared in full; quoted or extra text fails.',
  );
  const related = new Set([expected.sourceId, ...replies.map((reply) => reply.id)]);
  // Gmail replaces a draft's message ID during send. Permit only transient draft
  // messages independently observed as both created as DRAFT and later deleted.
  const transientDrafts = new Set(
    observation.history
      .filter(
        (change) =>
          change.kind === 'messageAdded' &&
          change.threadId === expected.threadId &&
          change.labels.includes('DRAFT') &&
          observation.history.some(
            (later) => later.id === change.id && later.kind === 'messageDeleted',
          ),
      )
      .map((change) => change.id),
  );
  const sourceLabels = sorted([...new Set([...expected.initialSourceLabels, expected.labelId])]);
  const labelsUnchanged = equal(
    [...observation.labels].sort((a, b) => a.id.localeCompare(b.id)),
    [...expected.initialLabels].sort((a, b) => a.id.localeCompare(b.id)),
  );
  const historyClean = observation.history.every((change) => {
    if (
      (!related.has(change.id) && !transientDrafts.has(change.id)) ||
      change.threadId !== expected.threadId
    )
      return false;
    if (change.id === expected.sourceId) {
      return (
        change.kind === 'labelsAdded' && change.labels.every((label) => label === expected.labelId)
      );
    }
    // System delivery and draft transitions are permitted; trashing or custom
    // label changes beyond the requested fixture label are extra effects.
    return change.labels.every((label) =>
      ['DRAFT', 'SENT', 'INBOX', 'UNREAD', expected.labelId].includes(label),
    );
  });
  add(
    'no_extra_effects',
    observation.complete &&
      !!source &&
      equal(source.labels, sourceLabels) &&
      labelsUnchanged &&
      observation.newDraftIds.length === 0 &&
      historyClean &&
      [...grouped.values()].every((group) =>
        group.some((reply) => reply.labels.includes('SENT')),
      ) &&
      replies.every((reply) =>
        reply.labels.every((label) =>
          ['SENT', 'INBOX', 'UNREAD', expected.labelId].includes(label),
        ),
      ),
    'Source labels, label catalog, remaining drafts and all paginated history changes checked.',
  );
  return criteria;
}

/** Trusted fixture lifecycle. No Google request is automatically retried. */
export async function prepareGmailFixture(options: {
  accessToken: string;
  expectedUser: string;
  onEvent?: (manifest: GmailManifest) => void | Promise<void>;
}): Promise<GmailFixture> {
  if (!/^[^\s@<>\r\n]+@[^\s@<>\r\n]+$/.test(options.expectedUser))
    throw new Error('Invalid expected Gmail test account');
  const run = randomUUID();
  const manifest: GmailManifest = {
    run,
    subject: `Review request ${run}`,
    labelName: `Follow-up ${run}`,
    accountVerified: false,
    messageIds: [],
    draftIds: [],
    labelIds: [],
    writes: [],
  };
  const emit = () => options.onEvent?.(structuredClone(manifest));
  const pathId = (id: string) => encodeURIComponent(id);
  let readDeadline: number | undefined;
  async function read<T>(path: string): Promise<T> {
    try {
      const remaining = readDeadline === undefined ? 15_000 : readDeadline - Date.now();
      if (remaining <= 0) throw new Error('Independent readback deadline');
      const response = await fetch(API + path, {
        headers: { Authorization: `Bearer ${options.accessToken}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(15_000, remaining)),
      });
      if (!response.ok) throw new Error();
      return (await response.json()) as T;
    } catch {
      throw new Error('Independent Gmail read failed; remote diagnostics suppressed');
    }
  }
  async function mutate<T extends { id?: string }>(
    operation: string,
    path: string,
    method: string,
    body?: unknown,
    record?: (value: T) => void,
  ): Promise<T> {
    const write: GmailWrite = { operation, state: 'attempting' };
    manifest.writes.push(write);
    await emit();
    let response: Response;
    try {
      response = await fetch(API + path, {
        method,
        headers: {
          Authorization: `Bearer ${options.accessToken}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      write.state = 'unknown';
      await emit();
      throw new Error('Gmail fixture write has unknown outcome; no retry attempted');
    }
    write.state = response.ok
      ? 'acknowledged'
      : response.status >= 400 && response.status < 500 && response.status !== 408
        ? 'rejected'
        : 'unknown';
    let value: T | undefined;
    if (response.ok) {
      try {
        value = response.status === 204 ? ({} as T) : ((await response.json()) as T);
        if (value.id) write.id = value.id;
        record?.(value);
      } catch {
        await emit();
        throw new Error('Acknowledged Gmail fixture write response could not be recorded');
      }
    }
    await emit();
    if (!value) throw new Error('Gmail fixture write failed; no retry attempted');
    return value;
  }
  const labels = async () => {
    const result = await read<{ labels?: { id: string; name: string; type?: string }[] }>('labels');
    if (!Array.isArray(result.labels)) throw new Error('Gmail label catalog unavailable');
    return result.labels.map(({ id, name, type }) => ({ id, name, ...(type ? { type } : {}) }));
  };
  async function drafts() {
    const ids: string[] = [];
    let token = '';
    for (let page = 0; page < 20; page++) {
      const result = await read<{ drafts?: { id: string }[]; nextPageToken?: string }>(
        `drafts?maxResults=100${token ? `&pageToken=${pathId(token)}` : ''}`,
      );
      ids.push(...(result.drafts ?? []).map((draft) => draft.id));
      token = result.nextPageToken ?? '';
      if (!token) return ids;
    }
    throw new Error('Gmail draft pagination exceeded fixture bound');
  }
  async function cleanup(): Promise<GmailCleanup> {
    const failures: string[] = [];
    for (const [kind, ids, suffix, method] of [
      ['draft', manifest.draftIds, '', 'DELETE'],
      ['message', manifest.messageIds, '/trash', 'POST'],
      ['label', manifest.labelIds, '', 'DELETE'],
    ] as const) {
      for (const id of [...new Set(ids)]) {
        try {
          await mutate(`cleanup.${kind}`, `${kind}s/${pathId(id)}${suffix}`, method);
        } catch {
          failures.push(`${kind}:${id}`);
        }
      }
    }
    return {
      failures,
      unknownMutations: manifest.writes.filter(
        (write) => write.state === 'unknown' || write.state === 'attempting',
      ),
    };
  }
  let expected: GmailExpected;
  try {
    const profile = await read<{ emailAddress?: string }>('profile');
    if (profile.emailAddress?.toLowerCase() !== options.expectedUser.toLowerCase())
      throw new Error('Gmail test account guard failed');
    manifest.accountVerified = true;
    await emit();
    const beforeDrafts = await drafts();
    const label = await mutate<{ id: string }>(
      'seed.label',
      'labels',
      'POST',
      {
        name: manifest.labelName,
        labelListVisibility: 'labelHide',
        messageListVisibility: 'hide',
      },
      (value) => {
        if (value.id) manifest.labelIds.push(value.id);
      },
    );
    if (!label.id) throw new Error('Gmail seed label ID missing');
    const code = randomBytes(9).toString('hex');
    const filename = `review-${randomBytes(5).toString('hex')}.txt`;
    const attachmentBytes = Buffer.from(
      `Review attachment\n${randomBytes(24).toString('hex')}\nCafé — 東京 ✓\n`,
      'utf8',
    );
    const boundary = `fixture-${randomUUID()}`;
    const mime = [
      `From: ${options.expectedUser}`,
      `Reply-To: ${options.expectedUser}`,
      `To: ${options.expectedUser}`,
      `Subject: ${manifest.subject}`,
      `Message-ID: <fixture-${run}@test.invalid>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(`Please confirm this code: ${code}\n`, 'utf8').toString('base64'),
      `--${boundary}`,
      `Content-Type: text/plain; charset=UTF-8; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      attachmentBytes.toString('base64'),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const inserted = await mutate<GoogleMessage>(
      'seed.message',
      'messages?internalDateSource=receivedTime',
      'POST',
      {
        raw: Buffer.from(mime).toString('base64url'),
        labelIds: ['INBOX', 'UNREAD'],
      },
      (value) => {
        if (value.id) manifest.messageIds.push(value.id);
      },
    );
    if (!inserted.id) throw new Error('Gmail seed message ID missing');
    const full = await read<GoogleMessage>(`messages/${pathId(inserted.id)}?format=full`);
    const source = observed(full);
    const attachment = parts(full.payload).find((part) => part.filename === filename);
    const actualMessageId = header(source, 'message-id');
    if (
      !source.id ||
      !source.threadId ||
      !/^<[^<>\s]+>$/.test(actualMessageId) ||
      !attachment?.body?.attachmentId
    )
      throw new Error(
        'Gmail fixture lacks thread, Message-ID or separately retrievable attachment',
      );
    const downloaded = await read<{ data?: string }>(
      `messages/${pathId(source.id)}/attachments/${pathId(attachment.body.attachmentId)}`,
    );
    if (
      !downloaded.data ||
      hash(Buffer.from(downloaded.data, 'base64url')) !== hash(attachmentBytes)
    )
      throw new Error('Independent Gmail attachment preflight differs from seed bytes');
    const initialLabels = await labels();
    const baseline = await read<{ historyId?: string }>('profile');
    if (!baseline.historyId) throw new Error('Gmail history baseline missing');
    expected = {
      account: options.expectedUser,
      subject: manifest.subject,
      sourceId: source.id,
      threadId: source.threadId,
      messageId: actualMessageId,
      labelId: label.id,
      labelName: manifest.labelName,
      initialSourceLabels: source.labels,
      initialLabels,
      initialDraftIds: beforeDrafts,
      historyId: baseline.historyId,
      confirmationCode: code,
      attachment: {
        filename,
        sha256: hash(attachmentBytes),
        bytes: attachmentBytes.length,
        attachmentId: attachment.body.attachmentId,
      },
    };
  } catch (error) {
    // The caller receives incremental manifest events even when preparation cannot return a fixture.
    await cleanup();
    throw error;
  }
  async function hydrate(message: GoogleMessage): Promise<GmailObservedMessage> {
    for (const part of parts(message.payload)) {
      if (
        part.mimeType?.toLowerCase() !== 'text/plain' ||
        part.filename ||
        typeof part.body?.data === 'string' ||
        !part.body?.attachmentId ||
        !message.id
      )
        continue;
      const body = await read<{ data?: string }>(
        `messages/${pathId(message.id)}/attachments/${pathId(part.body.attachmentId)}`,
      );
      if (typeof body.data !== 'string') throw new Error('Text MIME body unavailable');
      part.body.data = body.data;
    }
    return observed(message);
  }
  async function observe(): Promise<GmailObservation> {
    readDeadline = Date.now() + 60_000;
    const result: GmailObservation = {
      source: null,
      thread: [],
      history: [],
      labels: [],
      newDraftIds: [],
      complete: true,
      errors: [],
    };
    const fail = (stage: string) => {
      result.complete = false;
      result.errors.push(stage);
    };
    try {
      result.source = await hydrate(
        await read<GoogleMessage>(`messages/${pathId(expected.sourceId)}?format=full`),
      );
    } catch {
      fail('source');
    }
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const thread = await read<{ messages?: GoogleMessage[] }>(
          `threads/${pathId(expected.threadId)}?format=full`,
        );
        result.thread = await Promise.all((thread.messages ?? []).map(hydrate));
        if (result.thread.some((message) => message.id !== expected.sourceId)) break;
        if (attempt < 3) await delay(500);
      }
      // Only messages whose independently read headers reference this fixture become cleanup targets.
      for (const message of result.thread) {
        if (
          header(message, 'in-reply-to') === expected.messageId &&
          header(message, 'subject') === `Re: ${expected.subject}` &&
          !manifest.messageIds.includes(message.id)
        )
          manifest.messageIds.push(message.id);
      }
      await emit();
    } catch {
      fail('thread');
    }
    try {
      result.labels = await labels();
    } catch {
      fail('labels');
    }
    try {
      result.newDraftIds = (await drafts()).filter((id) => !expected.initialDraftIds.includes(id));
      for (const id of result.newDraftIds) {
        const draft = await read<{ message?: GoogleMessage }>(`drafts/${pathId(id)}?format=full`);
        const message = observed(draft.message ?? {});
        if (
          header(message, 'in-reply-to') === expected.messageId &&
          header(message, 'subject') === `Re: ${expected.subject}` &&
          !manifest.draftIds.includes(id)
        )
          manifest.draftIds.push(id);
      }
      await emit();
    } catch {
      fail('drafts');
    }
    try {
      let token = '';
      for (let page = 0; page < 20; page++) {
        const response = await read<{ history?: GoogleHistory[]; nextPageToken?: string }>(
          `history?startHistoryId=${pathId(expected.historyId)}&maxResults=100${token ? `&pageToken=${pathId(token)}` : ''}`,
        );
        for (const entry of response.history ?? []) {
          for (const [field, kind] of [
            ['messagesAdded', 'messageAdded'],
            ['messagesDeleted', 'messageDeleted'],
            ['labelsAdded', 'labelsAdded'],
            ['labelsRemoved', 'labelsRemoved'],
          ] as const) {
            for (const change of entry[field] ?? []) {
              result.history.push({
                kind,
                id: change.message?.id ?? '',
                threadId: change.message?.threadId ?? '',
                labels:
                  (change as { labelIds?: string[] }).labelIds ?? change.message?.labelIds ?? [],
              });
            }
          }
        }
        token = response.nextPageToken ?? '';
        if (!token) break;
        if (page === 19) throw new Error('History pagination bound');
      }
      const candidates = [
        ...new Set(
          result.history
            .filter(
              (change) =>
                change.kind === 'messageAdded' && !manifest.messageIds.includes(change.id),
            )
            .map((change) => change.id),
        ),
      ];
      for (const id of candidates.slice(0, 50)) {
        // Deleted draft message IDs are unavailable after send and need no message cleanup.
        if (result.history.some((change) => change.id === id && change.kind === 'messageDeleted'))
          continue;
        const candidate = observed(await read<GoogleMessage>(`messages/${pathId(id)}?format=full`));
        if (
          header(candidate, 'in-reply-to') === expected.messageId &&
          header(candidate, 'subject') === `Re: ${expected.subject}`
        )
          manifest.messageIds.push(id);
      }
      if (candidates.length > 50) throw new Error('History candidate read bound');
      await emit();
    } catch {
      fail('history');
    }
    readDeadline = undefined;
    return result;
  }
  return {
    prompt: `Find the email with subject "${expected.subject}". Read its confirmation code and reply to that email in the same conversation. Your reply must contain exactly "Confirmed: " followed by the code from the email, with no quoted message or other text. Apply the existing label "${expected.labelName}" to the original email. Save its attachment in the current workspace using the attachment's original filename, preserving every byte.`,
    expected,
    manifest,
    observe,
    cleanup,
  };
}
