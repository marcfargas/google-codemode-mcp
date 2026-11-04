import { DiscoveryCatalog } from './discovery.ts';
import { executeProgram, createExecutor } from './runtime.ts';
import type { ExecutionArguments, SnippetArguments } from './runtime.ts';
import { validateSnippets } from './snippets.ts';
import { handleMcp } from './protocol.ts';
import definitions from '../snippets.config.ts';

const snippets = validateSnippets(definitions);
const catalog = new DiscoveryCatalog();
export default {
  async fetch(request: Request, env: { LOADER: WorkerLoader }) {
    if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
    return handleMcp(request, {
      snippets,
      describe: async (args: { path?: string }) => {
        if (args.path === 'snippets') return { snippets };
        return catalog.describe(args.path);
      },
      execute: (args: ExecutionArguments) =>
        executeProgram({ args, catalog, snippets, executor: createExecutor(env.LOADER) }),
      runSnippet: async (name: string, args: SnippetArguments) => {
        const snippet = snippets.find((s) => s.name === name);
        if (!snippet) throw new Error('Unknown snippet');
        return executeProgram({
          args: { ...args, code: snippet.code },
          catalog,
          snippets,
          executor: createExecutor(env.LOADER),
          snippetName: name,
        });
      },
    });
  },
};
