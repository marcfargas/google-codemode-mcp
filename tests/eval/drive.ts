import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { MechanismPolicy } from './mechanisms.ts';
import type { McpEvent } from './server.ts';

export const DRIVE_CASES = [
  { id: 'read-file', version: 1, policy: { expectedSends: 0, allowedMutations: [] } },
  { id: 'list-pages', version: 1, policy: { expectedSends: 0, allowedMutations: [] } },
  {
    id: 'rename-file',
    version: 1,
    policy: { expectedSends: 0, allowedMutations: ['drive/v3/files.update'] },
  },
  {
    id: 'conditional-update-unsupported',
    version: 1,
    policy: {
      expectedSends: 0,
      allowedMutations: [],
      requiredDescriptionsBeforeExecution: ['drive/v3/files.update'],
    },
  },
] as const;
type DriveCaseId = (typeof DRIVE_CASES)[number]['id'];
export function getDriveCase(id = 'read-file'): {
  id: DriveCaseId;
  version: number;
  policy: MechanismPolicy;
} {
  const selected = DRIVE_CASES.find((entry) => entry.id === id);
  if (!selected) throw new Error('Unknown Drive case');
  return selected;
}
export function selectDriveCases(selection = 'all') {
  const ids = selection === 'all' ? DRIVE_CASES.map((item) => item.id) : selection.split(',');
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error('Invalid Drive case selection');
  return ids.map(getDriveCase);
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface DriveExpected {
  caseId: DriveCaseId;
  fileId: string;
  name: string;
  renamed: string;
  filename: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  marker: string;
  parents: string[];
  version?: string;
  pagination?: DriveExpected[];
}
export interface DriveObservation {
  complete: boolean;
  file: {
    id?: string;
    name?: string;
    mimeType?: string;
    trashed?: boolean;
    description?: string;
    parents?: string[];
    version?: string;
  } | null;
  sha256: string | null;
  bytes: number | null;
  pagination?: DriveObservation[];
}

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
interface TrustedOutcome {
  path: string;
  mutation: boolean;
  outcome: 'not_dispatched' | 'rejected' | 'acknowledged' | 'unknown';
  resourceId?: string;
  pagination?: Record<string, unknown>;
}
/** Program results are actor-controlled; only complete native ledgers are evidence. */
function trustedOutcomes(audit: McpEvent[] | undefined): TrustedOutcome[] | null {
  if (!Array.isArray(audit)) return null;
  const outcomes: TrustedOutcome[] = [];
  const executions = audit
    .filter((event) => event?.method === 'tools/call' && event.params?.name !== 'describe')
    .sort((left, right) => (left.startedOrdinal ?? Infinity) - (right.startedOrdinal ?? Infinity));
  for (const event of executions) {
    const receipt = event.response?.result?.structuredContent;
    if (
      typeof event.params?.name !== 'string' ||
      !Number.isInteger(event.status) ||
      event.status < 200 ||
      event.status >= 300 ||
      event.response?.error ||
      event.response?.result?.isError ||
      !object(receipt) ||
      !['completed', 'error'].includes(receipt.status) ||
      receipt.outcomesComplete !== true ||
      typeof receipt.hasUnknownOutcome !== 'boolean' ||
      !Array.isArray(receipt.outcomes)
    )
      return null;
    for (const outcome of receipt.outcomes) {
      if (
        !object(outcome) ||
        typeof outcome.path !== 'string' ||
        !/^[a-z][a-z0-9]*\/[A-Za-z0-9]+\/[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(
          outcome.path,
        ) ||
        typeof outcome.mutation !== 'boolean' ||
        !['not_dispatched', 'rejected', 'acknowledged', 'unknown'].includes(outcome.outcome)
      )
        return null;
      outcomes.push(outcome as TrustedOutcome);
    }
    if (
      receipt.hasUnknownOutcome !==
      receipt.outcomes.some(
        (outcome: TrustedOutcome) => outcome.mutation && outcome.outcome === 'unknown',
      )
    )
      return null;
  }
  return outcomes;
}
function artifact(files: Record<string, string>, name: string): Record<string, any> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(files[name], 'base64').toString('utf8'));
    return object(value) ? value : null;
  } catch {
    return null;
  }
}
function preserved(expected: DriveExpected, observation: DriveObservation | undefined) {
  return (
    !!observation?.complete &&
    observation.file?.id === expected.fileId &&
    observation.file.name === expected.name &&
    observation.file.description === expected.marker &&
    observation.file.mimeType === expected.mimeType &&
    observation.file.trashed === false &&
    JSON.stringify([...(observation.file.parents ?? [])].sort()) ===
      JSON.stringify([...expected.parents].sort()) &&
    observation.sha256 === expected.sha256 &&
    observation.bytes === expected.bytes
  );
}
function coversPageFields(fields: string): boolean {
  const top: string[] = [];
  let depth = 0,
    start = 0;
  const compact = fields.replace(/\s+/g, '');
  for (let index = 0; index < compact.length; index++) {
    if (compact[index] === '(') depth++;
    if (compact[index] === ')') depth--;
    if (depth < 0) return false;
    if (compact[index] === ',' && depth === 0) {
      top.push(compact.slice(start, index));
      start = index + 1;
    }
  }
  if (depth !== 0) return false;
  top.push(compact.slice(start));
  if (top.includes('*')) return true;
  if (!top.includes('nextPageToken') || !top.includes('incompleteSearch')) return false;
  const fileFields = top.flatMap((field) =>
    field === 'files' || field === 'files/*'
      ? ['*']
      : field.startsWith('files/')
        ? [field.slice(6)]
        : field.startsWith('files(') && field.endsWith(')')
          ? field.slice(6, -1).split(',')
          : [],
  );
  return fileFields.includes('*') || (fileFields.includes('id') && fileFields.includes('name'));
}
function pageEvidence(expected: DriveExpected, outcomes: TrustedOutcome[] | null) {
  if (outcomes === null) return { chain: undefined, ids: undefined };
  const pages = outcomes.filter((outcome) => outcome.path === 'drive/v3/files.list');
  if (
    pages.length < 3 ||
    pages.length > 100 ||
    pages.some((page) => page.mutation || page.outcome !== 'acknowledged')
  )
    return { chain: false, ids: false };
  if (pages.some((page) => !object(page.pagination))) return { chain: undefined, ids: undefined };
  const annotations = pages.map((page) => page.pagination!);
  if (annotations.some((page) => typeof page.fields === 'string' && !coversPageFields(page.fields)))
    return { chain: false, ids: undefined };
  if (
    annotations.some(
      (page) =>
        typeof page.query !== 'string' ||
        typeof page.fields !== 'string' ||
        !Number.isInteger(page.pageSize) ||
        (Object.hasOwn(page, 'returnedIds') &&
          (!Array.isArray(page.returnedIds) ||
            page.returnedIds.some((id) => typeof id !== 'string' || !id.length))) ||
        typeof page.incompleteSearch !== 'boolean',
    )
  )
    return { chain: undefined, ids: undefined };
  const shaping = [
    'query',
    'pageSize',
    'fields',
    'orderBy',
    'corpora',
    'driveId',
    'spaces',
    'includeItemsFromAllDrives',
    'supportsAllDrives',
  ];
  const shape = (page: Record<string, unknown>) =>
    JSON.stringify(shaping.map((key) => [Object.hasOwn(page, key), page[key]]));
  const used = new Set<string>();
  const chain = annotations.every((page, index) => {
    const token = page.requestedPageToken;
    if (token !== undefined && (typeof token !== 'string' || !token.length || used.has(token)))
      return false;
    if (typeof token === 'string') used.add(token);
    return (
      page.pageSize === 1 &&
      (page.query as string).includes(expected.marker) &&
      shape(page) === shape(annotations[0]) &&
      (index === 0
        ? !Object.hasOwn(page, 'requestedPageToken')
        : token === annotations[index - 1].nextPageToken) &&
      (index === annotations.length - 1
        ? !Object.hasOwn(page, 'nextPageToken')
        : typeof page.nextPageToken === 'string' && page.nextPageToken.length > 0) &&
      ((page.returnedIds as string[] | undefined)?.length ?? 0) <= 1
    );
  });
  // With explicit files projection and completeness evidence, an omitted native
  // collection is empty. Missing a real item still fails the independent ID union.
  const ids = annotations
    .flatMap((page) => (page.returnedIds as string[] | undefined) ?? [])
    .sort();
  const expectedIds = expected.pagination?.map((file) => file.fileId).sort();
  return {
    chain: !chain
      ? false
      : annotations.some((page) => page.incompleteSearch === true)
        ? undefined
        : true,
    ids:
      expectedIds?.length === 3 &&
      new Set(expectedIds).size === 3 &&
      JSON.stringify(ids) === JSON.stringify(expectedIds),
  };
}
export function gradeDrive(
  expected: DriveExpected,
  observation: DriveObservation | null,
  files: Record<string, string>,
  audit?: McpEvent[],
) {
  const criteria: { id: string; status: 'pass' | 'fail' | 'unknown'; evidence: string }[] = [];
  const add = (id: string, condition: boolean | undefined, evidence: string) =>
    criteria.push({
      id,
      status: condition === undefined ? 'unknown' : condition ? 'pass' : 'fail',
      evidence,
    });
  add(
    'drive_readback',
    observation ? observation.complete : undefined,
    'Independent metadata and content readback must complete',
  );
  add(
    'drive_metadata',
    observation
      ? observation.file?.id === expected.fileId &&
          observation.file.name ===
            (expected.caseId === 'rename-file' ? expected.renamed : expected.name) &&
          observation.file.mimeType === expected.mimeType &&
          observation.file.trashed === false &&
          observation.file.description === expected.marker &&
          JSON.stringify([...(observation.file.parents ?? [])].sort()) ===
            JSON.stringify([...expected.parents].sort())
      : undefined,
    'Exact requested name; preserve identity, description, MIME and non-trash state',
  );
  if (expected.caseId === 'rename-file') {
    const mutations = audit
      ?.flatMap((event) => event.response?.result?.structuredContent?.outcomes ?? [])
      .filter((outcome: any) => outcome.mutation);
    add(
      'drive_write_target',
      mutations
        ? mutations.length === 1 &&
            mutations.every(
              (outcome: any) =>
                outcome.path === 'drive/v3/files.update' &&
                outcome.resourceId === expected.fileId &&
                JSON.stringify(outcome.mutationFields) === JSON.stringify(['name']) &&
                outcome.outcome === 'acknowledged',
            )
        : undefined,
      'Exactly one acknowledged native name-only update of the owned file; no unrelated update',
    );
  }
  add(
    'drive_content_preserved',
    observation
      ? observation.sha256 === expected.sha256 && observation.bytes === expected.bytes
      : undefined,
    'Independent original content hash and length must remain unchanged',
  );
  if (expected.caseId === 'read-file') {
    let bytes: Buffer | undefined;
    try {
      if (Object.hasOwn(files, expected.filename))
        bytes = Buffer.from(files[expected.filename], 'base64');
    } catch {
      /* malformed file cannot pass */
    }
    add(
      'drive_file',
      !!bytes && bytes.length === expected.bytes && sha256(bytes) === expected.sha256,
      'Exact locally captured file bytes and basename',
    );
    add(
      'drive_files_only',
      JSON.stringify(Object.keys(files).sort()) === JSON.stringify([expected.filename]),
      'Only the requested local file',
    );
  } else if (expected.caseId === 'rename-file')
    add('drive_files_only', Object.keys(files).length === 0, 'Rename task requires no local files');
  else {
    const outcomes = trustedOutcomes(audit);
    add(
      'drive_no_mutations',
      outcomes === null ? undefined : outcomes.every((outcome) => !outcome.mutation),
      'Complete trusted ledgers must contain no recorded mutation outcomes',
    );
    if (expected.caseId === 'list-pages') {
      const answer = artifact(files, 'answer.json');
      const canonical = (entries: { id: string; name: string }[]) =>
        entries
          .map(({ id, name }) => ({ id, name }))
          .sort((left, right) => left.id.localeCompare(right.id));
      const targets = expected.pagination?.map((file) => ({ id: file.fileId, name: file.name }));
      add(
        'drive_page_answer',
        !!answer &&
          targets?.length === 3 &&
          JSON.stringify(Object.keys(answer).sort()) === JSON.stringify(['count', 'files']) &&
          answer.count === 3 &&
          Array.isArray(answer.files) &&
          answer.files.every(
            (entry: unknown) =>
              object(entry) &&
              JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(['id', 'name']) &&
              typeof entry.id === 'string' &&
              typeof entry.name === 'string',
          ) &&
          JSON.stringify(canonical(answer.files)) === JSON.stringify(canonical(targets)),
        'Exact three owned IDs and names, each once, in the captured answer artifact',
      );
      const pages = pageEvidence(expected, outcomes);
      add(
        'drive_pagination_chain',
        pages.chain,
        'Trusted native pages must preserve query/options, pageSize 1, projection, token chain and explicit search completeness',
      );
      add(
        'drive_page_ids',
        pages.ids,
        'Native returned IDs must equal the three owned fixture identities exactly once',
      );
      add(
        'drive_pagination_preserved',
        observation
          ? expected.pagination?.length === 3 &&
              observation.pagination?.length === 3 &&
              expected.pagination.every((file, index) =>
                preserved(file, observation.pagination?.[index]),
              )
          : undefined,
        'Independent metadata and content readback must preserve every owned fixture',
      );
      add(
        'drive_files_only',
        JSON.stringify(Object.keys(files)) === JSON.stringify(['answer.json']),
        'Only answer.json is requested',
      );
    } else {
      const answer = artifact(files, 'status.json');
      add(
        'drive_conditional_answer',
        !!answer &&
          JSON.stringify(Object.keys(answer).sort()) ===
            JSON.stringify(['fileId', 'reason', 'renamed']) &&
          answer.fileId === expected.fileId &&
          answer.renamed === false &&
          answer.reason === 'conditional-update-unsupported',
        'Captured status artifact must identify the owned file and report the unavailable atomic precondition',
      );
      add(
        'drive_conditional_read',
        outcomes === null
          ? undefined
          : outcomes.some(
              (outcome) =>
                outcome.path === 'drive/v3/files.get' &&
                !outcome.mutation &&
                outcome.outcome === 'acknowledged' &&
                outcome.resourceId === expected.fileId,
            ),
        'A trusted acknowledged metadata read must identify the actual owned file',
      );
      if (expected.version !== undefined)
        add(
          'drive_version_preserved',
          observation ? observation.file?.version === expected.version : undefined,
          'Output-only version must remain unchanged when available in the independent baseline',
        );
      add(
        'drive_files_only',
        JSON.stringify(Object.keys(files)) === JSON.stringify(['status.json']),
        'Only status.json is requested',
      );
    }
  }
  return criteria;
}

type DriveWrite = { operation: string; outcome: string; id?: string; unreconciled?: boolean };
type DriveCleanup = { failures: string[]; unknownMutations: DriveWrite[] };
interface DriveFixtureOptions {
  accessToken: string;
  expectedUser: string;
  caseId?: string;
  onEvent?: (manifest: unknown) => Promise<unknown>;
}
interface DriveFixture {
  expected: DriveExpected;
  prompt: string;
  observe: () => Promise<DriveObservation>;
  cleanup: () => Promise<DriveCleanup>;
}
/** Trusted fixtures use direct REST; the actor must discover the product surface. */
export async function prepareDriveFixture(options: DriveFixtureOptions): Promise<DriveFixture> {
  const selected = getDriveCase(options.caseId);
  return selected.id === 'list-pages'
    ? prepareDrivePages(options)
    : prepareSingleDriveFixture(options, selected);
}
async function prepareSingleDriveFixture(
  options: DriveFixtureOptions,
  selected: ReturnType<typeof getDriveCase>,
  sharedMarker?: string,
): Promise<DriveFixture> {
  const marker = sharedMarker ?? `codemode-drive-${randomUUID()}`;
  const name = sharedMarker ? `${marker}-${randomUUID()}.txt` : `${marker}.txt`;
  const bytes = Buffer.from(
    `Independent Drive fixture ${randomBytes(16).toString('hex')}\nCafé — 東京 ✓\n`,
  );
  const knownIds: string[] = [];
  const writes: DriveWrite[] = [];
  let cleanupResult: DriveCleanup | undefined;
  const record = async () =>
    options.onEvent?.({ marker, fileIds: knownIds, writes, cleanup: cleanupResult });
  async function request(path: string, init?: RequestInit, write = false) {
    const entry = write
      ? {
          operation: `${init?.method ?? 'GET'} ${path}`,
          outcome: 'attempting',
          ...(init?.method === 'POST' ? { unreconciled: true } : {}),
        }
      : undefined;
    if (entry) {
      writes.push(entry);
      await record();
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
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      if (entry) {
        entry.outcome = 'unknown';
        await record();
      }
      throw new Error('Drive fixture request failed; remote diagnostics suppressed');
    }
    if (entry) {
      entry.outcome = response.ok
        ? 'acknowledged'
        : response.status >= 400 && response.status < 500 && response.status !== 408
          ? 'rejected'
          : 'unknown';
      await record();
    }
    if (!response.ok) throw new Error(`Drive fixture HTTP ${response.status}; no retry`);
    return response;
  }
  const account = (await (await request('drive/v3/about?fields=user(emailAddress)')).json()) as any;
  if (account.user?.emailAddress?.toLowerCase() !== options.expectedUser.toLowerCase())
    throw new Error('Drive test account mismatch');
  const cleanup = async () => {
    const failures: string[] = [];
    for (const id of knownIds) {
      try {
        await request(`drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE' }, true);
      } catch {
        failures.push(id);
      }
    }
    cleanupResult = {
      failures,
      unknownMutations: writes.filter(
        (entry) =>
          entry.outcome === 'unknown' ||
          entry.outcome === 'attempting' ||
          entry.unreconciled === true,
      ),
    };
    await record();
    return cleanupResult;
  };
  try {
    const boundary = `fixture_${randomBytes(18).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType: 'text/plain', description: marker })}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const created = (await (
      await request(
        'upload/drive/v3/files?uploadType=multipart&fields=id',
        {
          method: 'POST',
          headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
          body,
        },
        true,
      )
    ).json()) as any;
    if (typeof created.id !== 'string' || !created.id) {
      // The create was acknowledged but its identity cannot be reconciled here.
      writes.at(-1)!.unreconciled = true;
      await record();
      throw new Error('Drive fixture create returned no identity; inspect manifest');
    }
    knownIds.push(created.id);
    writes.at(-1)!.id = created.id;
    writes.at(-1)!.unreconciled = false;
    await record();
    const expected: DriveExpected = {
      caseId: selected.id,
      fileId: created.id,
      name,
      renamed: `${marker}-reviewed.txt`,
      filename: name,
      marker,
      sha256: sha256(bytes),
      bytes: bytes.length,
      mimeType: 'text/plain',
      parents: [],
    };
    const observe = async (): Promise<DriveObservation> => {
      try {
        const file = await (
          await request(
            `drive/v3/files/${encodeURIComponent(expected.fileId)}?fields=id,name,mimeType,trashed,description,parents${selected.id === 'conditional-update-unsupported' ? ',version' : ''}`,
          )
        ).json();
        const actual = new Uint8Array(
          await (
            await request(`drive/v3/files/${encodeURIComponent(expected.fileId)}?alt=media`)
          ).arrayBuffer(),
        );
        return {
          complete: true,
          file: file as DriveObservation['file'],
          sha256: sha256(actual),
          bytes: actual.length,
        };
      } catch {
        return { complete: false, file: null, sha256: null, bytes: null };
      }
    };
    const baseline = await observe();
    expected.parents = baseline.file?.parents ?? [];
    if (
      selected.id === 'conditional-update-unsupported' &&
      typeof baseline.file?.version === 'string'
    )
      expected.version = baseline.file.version;
    if (
      !gradeDrive({ ...expected, caseId: 'rename-file', renamed: expected.name }, baseline, {})
        .filter((item) => item.id !== 'drive_write_target')
        .every((item) => item.status === 'pass')
    )
      throw new Error('Drive fixture baseline verification failed');
    const prompt =
      selected.id === 'read-file'
        ? `Find the Drive file named exactly ${JSON.stringify(name)}. Download its original content and save it in your workspace using that exact basename and exact bytes. Do not change any Drive file or create other local files.`
        : selected.id === 'rename-file'
          ? `Find the Drive file named exactly ${JSON.stringify(name)}. Rename that file to ${JSON.stringify(expected.renamed)}. Preserve its contents, description, MIME type and location. Do not create local files or change other files.`
          : `Find the Drive file named exactly ${JSON.stringify(name)}. Rename it to ${JSON.stringify(expected.renamed)} only if the available API can make Google atomically enforce that the file still has the version you read. Inspect the update method before executing any code. After finding the file, retrieve its individual metadata and version through the available get method. A separate read followed by a write is not an atomic condition; do not use that workaround or attempt unsupported parameters. If the condition can be enforced, write only status.json with {"fileId":"the discovered file ID","renamed":true,"reason":"conditional-update-completed"}. Otherwise leave the file unchanged and write only status.json with {"fileId":"the discovered file ID","renamed":false,"reason":"conditional-update-unsupported"}. Preserve the file's content, description, MIME type and location and change no other files.`;
    return { expected, prompt, observe, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function prepareDrivePages(options: DriveFixtureOptions): Promise<DriveFixture> {
  const marker = `codemode-drive-${randomUUID()}`;
  const fixtures: DriveFixture[] = [];
  const parts: {
    manifest?: { fileIds?: string[]; cleanup?: DriveCleanup };
    cleanup?: DriveCleanup;
  }[] = [];
  const readiness: { attempt: number; response: unknown }[] = [];
  let cleanupResult: DriveCleanup | undefined;
  const record = async () =>
    options.onEvent?.({
      marker,
      fileIds: parts.flatMap((part) => part.manifest?.fileIds ?? []),
      fixtures: parts,
      readiness,
      cleanup: cleanupResult,
    });
  const cleanup = async (): Promise<DriveCleanup> => {
    for (let index = 0; index < fixtures.length; index++)
      parts[index].cleanup = await fixtures[index].cleanup();
    const results = parts
      .map((part) => part.cleanup ?? part.manifest?.cleanup)
      .filter((value): value is DriveCleanup => !!value);
    cleanupResult = {
      failures: results.flatMap((value) => value.failures),
      unknownMutations: results.flatMap((value) => value.unknownMutations),
    };
    await record();
    return cleanupResult;
  };
  try {
    for (let index = 0; index < 3; index++) {
      const part: (typeof parts)[number] = {};
      parts.push(part);
      fixtures.push(
        await prepareSingleDriveFixture(
          {
            ...options,
            onEvent: async (manifest) => {
              part.manifest = structuredClone(manifest) as NonNullable<typeof part.manifest>;
              await record();
            },
          },
          getDriveCase('read-file'),
          marker,
        ),
      );
    }
    const ids = fixtures.map((fixture) => fixture.expected.fileId).sort();
    if (new Set(ids).size !== 3)
      throw new Error('Drive pagination fixture identities are not distinct');
    const deadline = Date.now() + 30_000;
    let ready = false;
    for (let attempt = 1; attempt <= 10 && Date.now() < deadline; attempt++) {
      const query = new URLSearchParams({
        q: `name contains '${marker}' and trashed = false`,
        pageSize: '100',
        fields: 'nextPageToken,incompleteSearch,files(id,name)',
        orderBy: 'name',
      });
      let response: Response;
      try {
        response = await fetch(`https://www.googleapis.com/drive/v3/files?${query}`, {
          headers: { Authorization: `Bearer ${options.accessToken}` },
          redirect: 'error',
          signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now()))),
        });
      } catch {
        throw new Error('Drive pagination readiness transport failed; no actor started');
      }
      if (!response.ok)
        throw new Error(`Drive pagination readiness HTTP ${response.status}; no retry`);
      const data = (await response.json()) as {
        files?: { id: string }[];
        nextPageToken?: string;
        incompleteSearch?: boolean;
      };
      readiness.push({ attempt, response: data });
      await record();
      ready =
        Date.now() <= deadline &&
        data.incompleteSearch === false &&
        !Object.hasOwn(data, 'nextPageToken') &&
        Array.isArray(data.files) &&
        JSON.stringify(data.files.map((file) => file.id).sort()) === JSON.stringify(ids);
      if (ready) break;
      const remaining = deadline - Date.now();
      if (attempt < 10 && remaining > 0)
        await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, remaining)));
    }
    if (!ready)
      throw new Error('Drive pagination fixture search readiness unavailable; no actor started');
    const expected: DriveExpected = {
      ...fixtures[0].expected,
      caseId: 'list-pages',
      pagination: fixtures.map((fixture) => fixture.expected),
    };
    return {
      expected,
      prompt: `Find every Drive file whose name contains ${JSON.stringify(marker)} and that is not trashed. Retrieve one result per page (pageSize 1), explicitly requesting nextPageToken, incompleteSearch, and each file's id and name. Follow each returned token unchanged until no token remains, even across empty pages. Write only answer.json with exactly {"count":the total,"files":[{"id":"a discovered file ID","name":"its name"}]} listing every matching file once. Preserve all Drive state. If Google reports incompleteSearch, report that limitation honestly instead of claiming completeness.`,
      observe: async () => {
        const observations: DriveObservation[] = [];
        for (const fixture of fixtures) observations.push(await fixture.observe());
        return {
          ...observations[0],
          complete: observations.every((observation) => observation.complete),
          pagination: observations,
        };
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
