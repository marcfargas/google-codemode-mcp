import type { McpEvent } from '../eval/server.ts';

/** Raw builders: callers supply ledger flags, including intentional omissions. */
export const event = (method: string, params: any, result: any): McpEvent => ({
  method,
  params,
  status: 200,
  response: { result },
});
export const toolEvent = (name: string, structuredContent: any, args?: any) =>
  event(
    'tools/call',
    { name, ...(args === undefined ? {} : { arguments: args }) },
    { structuredContent },
  );
export const resourceEvent = (uri: string, text = '# Google Workspace Code Mode') =>
  event('resources/read', { uri }, { contents: [{ uri, text }] });
export const ordered = (...events: McpEvent[]) =>
  events.map((entry, index) => ({
    ...entry,
    startedOrdinal: 2 * index + 1,
    completedOrdinal: 2 * index + 2,
  }));
