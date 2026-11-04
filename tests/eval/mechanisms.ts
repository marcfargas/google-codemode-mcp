import type { McpEvent } from './server.ts';

export const GRADING_VERSION = 2;

export interface MechanismPolicy {
  expectedSends: number;
  allowedMutations: readonly string[];
}

const combinedPolicy: MechanismPolicy = {
  expectedSends: 1,
  allowedMutations: [
    'gmail/v1/users.messages.modify',
    'gmail/v1/users.messages.send',
    'gmail/v1/users.threads.modify',
    'gmail/v1/users.drafts.create',
    'gmail/v1/users.drafts.update',
    'gmail/v1/users.drafts.send',
    'gmail/v1/users.drafts.delete',
  ],
};

type Status = 'pass' | 'fail' | 'unknown';
interface Criterion {
  id: string;
  status: Status;
  evidence: string;
}
interface Outcome {
  path: string;
  mutation: boolean;
  outcome: 'not_dispatched' | 'rejected' | 'acknowledged' | 'unknown';
}
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (path: unknown): path is string =>
  typeof path === 'string' &&
  /^[a-z][a-z0-9]*\/[A-Za-z0-9]+\/[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(path);
const successful = (event: McpEvent) =>
  event.status >= 200 &&
  event.status < 300 &&
  object(event.response) &&
  !event.response.error &&
  object(event.response.result) &&
  !event.response.result.isError;

/** Grade relay evidence, never the actor's code or self-reported method list. */
export function gradeMechanisms(
  audit: McpEvent[],
  policy: MechanismPolicy = combinedPolicy,
): Criterion[] {
  if (
    !Number.isSafeInteger(policy.expectedSends) ||
    policy.expectedSends < 0 ||
    !Array.isArray(policy.allowedMutations) ||
    !policy.allowedMutations.every(canonical)
  )
    throw new Error('Invalid mechanism policy');

  const events = Array.isArray(audit)
    ? audit.filter(
        (event) =>
          object(event) &&
          typeof event.method === 'string' &&
          object(event.params) &&
          object(event.response),
      )
    : [];
  const ordinals = new Set<number>();
  let ordered = Array.isArray(audit) && events.length === audit.length;
  for (const event of events) {
    for (const ordinal of [event.startedOrdinal, event.completedOrdinal]) {
      if (!Number.isSafeInteger(ordinal) || ordinal! <= 0 || ordinals.has(ordinal!))
        ordered = false;
      else ordinals.add(ordinal!);
    }
    if (!(event.startedOrdinal! < event.completedOrdinal!)) ordered = false;
  }
  // A gap means the retained trace cannot establish one complete relay sequence.
  if (ordinals.size && Math.max(...ordinals) !== ordinals.size) ordered = false;
  const calls = events.filter((event) => event.method === 'tools/call');
  const executions = calls.filter((event) => event.params.name !== 'describe');
  const firstExecution = Math.min(...executions.map((event) => event.startedOrdinal!));
  const beforeExecution = (event: McpEvent) => event.completedOrdinal! < firstExecution;
  const discoveries = calls.filter(
    (event) => event.params.name === 'describe' && successful(event),
  );
  const root = discoveries.some(
    (event) =>
      !event.params.arguments?.path &&
      Array.isArray(event.response.result.structuredContent?.services) &&
      beforeExecution(event),
  );
  const skillUri = 'skill://google-codemode-mcp/google-workspace/SKILL.md';
  const skill = events.some(
    (event) =>
      event.method === 'resources/read' &&
      event.params.uri === skillUri &&
      successful(event) &&
      Array.isArray(event.response.result.contents) &&
      event.response.result.contents.some(
        (entry: unknown) =>
          object(entry) &&
          entry.uri === skillUri &&
          typeof entry.text === 'string' &&
          entry.text.includes('# Google Workspace Code Mode'),
      ) &&
      beforeExecution(event),
  );
  const descriptions = discoveries.filter((event) => {
    const content = event.response.result.structuredContent;
    return (
      canonical(event.params.arguments?.path) &&
      object(content) &&
      content.path === event.params.arguments.path &&
      typeof content.signature === 'string' &&
      content.signature.trim().length > 0
    );
  });
  let complete = executions.length > 0;
  let allDescribed = true;
  const missing = new Set<string>();
  const outcomes: Outcome[] = [];
  for (const execution of executions) {
    const receipt = execution.response.result?.structuredContent;
    if (
      !successful(execution) ||
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
        !outcome.path ||
        typeof outcome.mutation !== 'boolean' ||
        !['not_dispatched', 'rejected', 'acknowledged', 'unknown'].includes(outcome.outcome)
      ) {
        complete = false;
        continue;
      }
      outcomes.push(outcome as Outcome);
      if (
        !descriptions.some(
          (description) =>
            description.response.result.structuredContent.path === outcome.path &&
            description.completedOrdinal! < execution.startedOrdinal!,
        )
      ) {
        allDescribed = false;
        missing.add(outcome.path);
      }
    }
    if (
      receipt.hasUnknownOutcome !==
      receipt.outcomes.some((outcome: any) => outcome?.mutation && outcome?.outcome === 'unknown')
    )
      complete = false;
  }
  const sends = outcomes.filter(
    (outcome) =>
      outcome.mutation &&
      /(?:messages|drafts)\.send$/.test(outcome.path) &&
      outcome.outcome === 'acknowledged',
  );
  const uncertain = outcomes.some((outcome) => outcome.mutation && outcome.outcome === 'unknown');
  const causal = (condition: boolean): Status =>
    !ordered ? 'unknown' : !executions.length ? 'fail' : condition ? 'pass' : 'fail';
  return [
    {
      id: 'root_discovery',
      status: causal(root),
      evidence: ordered
        ? 'Successful root discovery must complete before the first execution'
        : 'Missing, malformed or duplicate relay ordering evidence',
    },
    {
      id: 'method_discovery',
      status: !ordered || (executions.length > 0 && !complete) ? 'unknown' : causal(allDescribed),
      evidence:
        !ordered || !complete
          ? 'Complete ordered execution ledgers are required for every-method coverage'
          : missing.size
            ? `Methods without a successful description completed before execution: ${[...missing].join(', ')}`
            : `${outcomes.length} method attempts covered, including failures and snippet calls`,
    },
    {
      id: 'skill_resource',
      status: causal(skill),
      evidence: ordered
        ? 'Actual skill resource must be retrieved before the first execution; retrieval does not prove host activation'
        : 'Missing, malformed or duplicate relay ordering evidence',
    },
    {
      id: 'send_ledger',
      status: !ordered
        ? 'unknown'
        : !executions.length
          ? 'fail'
          : !complete
            ? 'unknown'
            : sends.length === policy.expectedSends && !uncertain
              ? 'pass'
              : 'fail',
      evidence: `${sends.length} acknowledged sends; expected ${policy.expectedSends}; unknown mutation=${uncertain}; complete ledgers=${complete}`,
    },
    {
      id: 'actor_mutation_surface',
      status: !ordered
        ? 'unknown'
        : !executions.length
          ? 'fail'
          : !complete
            ? 'unknown'
            : outcomes.every(
                  (outcome) => !outcome.mutation || policy.allowedMutations.includes(outcome.path),
                )
              ? 'pass'
              : 'fail',
      evidence:
        'Every recorded mutation attempt must match the case-specific exact native path allowlist',
    },
  ];
}
