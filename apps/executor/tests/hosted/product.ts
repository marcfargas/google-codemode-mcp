import product from '../../src/worker.ts';

interface Environment {
  LOADER: WorkerLoader;
  CANDIDATE_DIGEST: string;
  WORKER_VERSION: { id: string };
  ARTIFACTS?: R2Bucket;
  ARTIFACT_DOWNLOAD_ORIGIN?: string;
}

/** Test-deployment identity only; all MCP behavior comes from the product. */
export default {
  async fetch(request: Request, env: Environment, ctx?: ExecutionContext) {
    if (!/^[a-f0-9]{64}$/.test(env.CANDIDATE_DIGEST ?? '') || !env.WORKER_VERSION?.id)
      return Response.json({ error: 'Prepared candidate identity required' }, { status: 503 });
    const response = await product.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    headers.set('x-candidate-digest', env.CANDIDATE_DIGEST);
    headers.set('x-worker-version', env.WORKER_VERSION.id);
    return new Response(response.body, { status: response.status, headers });
  },
};
