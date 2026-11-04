import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { MechanismPolicy } from './mechanisms.ts';
import type { McpEvent } from './server.ts';

export const DRIVE_CASES = [
  { id: 'read-file', version: 1, policy: { expectedSends: 0, allowedMutations: [] } },
  {
    id: 'rename-file',
    version: 1,
    policy: { expectedSends: 0, allowedMutations: ['drive/v3/files.update'] },
  },
] as const;
export function getDriveCase(id = 'read-file'): {
  id: 'read-file' | 'rename-file';
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
  caseId: 'read-file' | 'rename-file';
  fileId: string;
  name: string;
  renamed: string;
  filename: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  marker: string;
  parents: string[];
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
  } | null;
  sha256: string | null;
  bytes: number | null;
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
  } else
    add('drive_files_only', Object.keys(files).length === 0, 'Rename task requires no local files');
  return criteria;
}

/** Trusted fixtures use direct REST; the actor must discover the product surface. */
export async function prepareDriveFixture(options: {
  accessToken: string;
  expectedUser: string;
  caseId?: string;
  onEvent?: (manifest: unknown) => Promise<unknown>;
}) {
  const selected = getDriveCase(options.caseId);
  const marker = `codemode-drive-${randomUUID()}`;
  const name = `${marker}.txt`;
  const bytes = Buffer.from(
    `Independent Drive fixture ${randomBytes(16).toString('hex')}\nCafé — 東京 ✓\n`,
  );
  const knownIds: string[] = [];
  const writes: { operation: string; outcome: string; id?: string; unreconciled?: boolean }[] = [];
  let cleanupResult: { failures: string[]; unknownMutations: typeof writes } | undefined;
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
            `drive/v3/files/${encodeURIComponent(expected.fileId)}?fields=id,name,mimeType,trashed,description,parents`,
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
      !gradeDrive({ ...expected, caseId: 'rename-file', renamed: expected.name }, baseline, {})
        .filter((item) => item.id !== 'drive_write_target')
        .every((item) => item.status === 'pass')
    )
      throw new Error('Drive fixture baseline verification failed');
    const prompt =
      selected.id === 'read-file'
        ? `Find the Drive file named exactly ${JSON.stringify(name)}. Download its original content and save it in your workspace using that exact basename and exact bytes. Do not change any Drive file or create other local files.`
        : `Find the Drive file named exactly ${JSON.stringify(name)}. Rename that file to ${JSON.stringify(expected.renamed)}. Preserve its contents, description, MIME type and location. Do not create local files or change other files.`;
    return { expected, prompt, observe, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
