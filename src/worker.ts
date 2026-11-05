import { DiscoveryCatalog } from './discovery.ts';
import { executeProgram, createExecutor, PAGINATION_CAPABILITIES } from './runtime.ts';
import type { ExecutionArguments, SnippetArguments } from './runtime.ts';
import { validateSnippets } from './snippets.ts';
import { handleMcp } from './protocol.ts';
import definitions from '../snippets.config.ts';
import { createArtifactStore, ARTIFACTS_CAPABILITIES } from './artifacts.ts';

const snippets = validateSnippets(definitions);
const catalog = new DiscoveryCatalog();
export default {
  async fetch(
    request: Request,
    env: { LOADER: WorkerLoader; ARTIFACTS?: R2Bucket; ARTIFACT_DOWNLOAD_ORIGIN?: string },
    ctx?: Pick<ExecutionContext, 'waitUntil'>,
  ) {
    const artifactStore = createArtifactStore(env.ARTIFACTS, {
      downloadOrigin: env.ARTIFACT_DOWNLOAD_ORIGIN,
    });
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/mcp/artifacts/')) return artifactStore.download(request);
    if (pathname !== '/mcp') return new Response('Not found', { status: 404 });
    const executionOptions = { artifactStore, waitUntil: ctx?.waitUntil.bind(ctx) };
    return handleMcp(request, {
      snippets,
      readResource: artifactStore.readResource,
      describe: async (args: { path?: string }) => {
        if (args.path === 'snippets') return { snippets };
        if (args.path === 'pagination') return PAGINATION_CAPABILITIES;
        if (args.path === 'artifacts')
          return {
            ...ARTIFACTS_CAPABILITIES,
            enabled: !!env.ARTIFACTS,
            downloads: { enabled: artifactStore.downloadsEnabled },
          };
        if (!args.path)
          return {
            ...(await catalog.describe()),
            pagination: { path: 'pagination', skill: PAGINATION_CAPABILITIES.skill },
            artifacts: {
              path: 'artifacts',
              enabled: !!env.ARTIFACTS,
              skill: 'skill://google-codemode-mcp/google-workspace/references/artifacts.md',
            },
          };
        return catalog.describe(args.path);
      },
      execute: (args: ExecutionArguments) =>
        executeProgram({
          args,
          catalog,
          snippets,
          executor: createExecutor(env.LOADER),
          ...executionOptions,
        }),
      runSnippet: async (name: string, args: SnippetArguments) => {
        const snippet = snippets.find((s) => s.name === name);
        if (!snippet) throw new Error('Unknown snippet');
        return executeProgram({
          args: { ...args, code: snippet.code },
          catalog,
          snippets,
          executor: createExecutor(env.LOADER),
          snippetName: name,
          ...executionOptions,
        });
      },
    });
  },
};
