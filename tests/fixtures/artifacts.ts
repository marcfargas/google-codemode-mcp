import { DiscoveryCatalog } from '../../src/discovery.ts';
import { executeProgram, createExecutor } from '../../src/runtime.ts';
import { handleMcp } from '../../src/protocol.ts';
import { createArtifactStore } from '../../src/artifacts.ts';
import { validateSnippets } from '../../src/snippets.ts';

const snippets = validateSnippets([
  {
    name: 'artifactProbe',
    description: 'Test snippet artifact isolation',
    code: `return artifacts.putJson({from:'snippet'});`,
    inputSchema: { type: 'object', additionalProperties: false },
    services: [],
    scopes: [],
    tool: { name: 'artifact_probe' },
  },
]);
const catalog = new DiscoveryCatalog();
export default {
  fetch(
    request: Request,
    env: { LOADER: WorkerLoader; ARTIFACTS?: R2Bucket },
    ctx: ExecutionContext,
  ) {
    const store = createArtifactStore(
      env.ARTIFACTS
        ? {
            get: env.ARTIFACTS.get.bind(env.ARTIFACTS),
            delete: env.ARTIFACTS.delete.bind(env.ARTIFACTS),
            put: async () => {
              throw new Error('Injected storage failure');
            },
          }
        : undefined,
    );
    const execute = (args: Parameters<typeof executeProgram>[0]['args'], snippetName?: string) =>
      executeProgram({
        args,
        snippetName,
        catalog,
        snippets,
        executor: createExecutor(env.LOADER),
        artifactStore: store,
        waitUntil: ctx.waitUntil.bind(ctx),
      });
    return handleMcp(request, {
      snippets,
      describe: (args) => catalog.describe(args.path),
      execute,
      runSnippet: (name, args) => execute({ ...args, code: '' }, name),
      readResource: store.readResource,
    });
  },
};
