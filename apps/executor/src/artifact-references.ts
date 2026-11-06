import type { ArtifactReference } from './artifacts.ts';

const references = new WeakMap<object, readonly ArtifactReference[]>();

/** Only the trusted execution controller registers references for MCP links. */
export function registerExecutionArtifactReferences(
  value: object,
  refs: readonly ArtifactReference[],
) {
  references.set(value, structuredClone(refs));
}

export function executionArtifactReferences(value: unknown): readonly ArtifactReference[] {
  return value && typeof value === 'object' ? (references.get(value) ?? []) : [];
}
