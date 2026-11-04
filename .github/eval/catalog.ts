/** Metadata-only availability check; no inference, OAuth refresh, or fixtures. */
export async function verifyModels(proxyUrl: string, key: string, models: string[]) {
  const origin = new URL(proxyUrl);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error('Use a credential-free HTTP proxy base URL');
  const response = await fetch(proxyUrl.replace(/\/$/, '') + '/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Proxy model catalogue unavailable; no agent started');
  const catalogue = (await response.json()) as { data?: { id: string }[] };
  const available = new Set(catalogue.data?.map((entry) => entry.id));
  for (const model of models)
    if (!available.has(model)) throw new Error(`Proxy does not advertise selected model: ${model}`);
  return {
    checkedAt: new Date().toISOString(),
    models,
    evidence: 'proxy advertised IDs; not proof of inference availability',
  };
}
