import type { DiscoverySchema } from './discovery.ts';

function excerpt(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  const head = normalized.slice(0, limit - 1);
  const space = head.lastIndexOf(' ');
  return (space > limit / 2 ? head.slice(0, space) : head) + '…';
}

export function schemaSummary(service: string, schema: DiscoverySchema): Record<string, unknown> {
  return {
    type: schema.repeated ? 'array' : schema.type,
    schemaPath: schema.$ref ? `${service}#${schema.$ref}` : undefined,
    items: schema.repeated
      ? schemaSummary(service, { ...schema, repeated: false })
      : schema.items && schemaSummary(service, schema.items),
    format: schema.format,
    required: schema.required || undefined,
    readOnly: schema.readOnly || undefined,
    deprecated: schema.deprecated || undefined,
  };
}

export function parameterBrief(service: string, schema: DiscoverySchema) {
  return {
    ...schemaSummary(service, schema),
    location: schema.location,
    default: schema.default,
    enum: schema.enum,
    minimum: schema.minimum,
    maximum: schema.maximum,
    pattern: schema.pattern,
    summary: excerpt(schema.description, 96),
  };
}

export function methodSummary(description?: string) {
  return excerpt(description, 160);
}

export function schemaInventory(service: string, path: string, schema: DiscoverySchema) {
  return {
    ...schemaSummary(service, schema),
    fields: Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, value]) => [
        key,
        schemaSummary(service, value),
      ]),
    ),
    fieldPath: schema.properties ? `${path}/properties/<field>` : undefined,
  };
}

/** A field path walks raw Discovery schema nodes only. Named references are resolved separately. */
export function selectSchemaNode(schema: DiscoverySchema, pointer: string): DiscoverySchema {
  if (pointer.length > 512) throw new Error('Google schema field path is too long');
  const steps = pointer.split('/').map((part) => {
    if (/~(?![01])/.test(part)) throw new Error('Invalid Google schema field path');
    return part.replaceAll('~1', '/').replaceAll('~0', '~');
  });
  if (steps.length > 16) throw new Error('Google schema field path is too long');
  let current = schema;
  for (let i = 0; i < steps.length; i++) {
    const edge = steps[i];
    let next: unknown;
    if (edge === 'properties' || edge === 'anyOf') {
      const key = steps[++i];
      const collection = Object.hasOwn(current, edge) ? current[edge] : undefined;
      if (
        key !== undefined &&
        collection &&
        typeof collection === 'object' &&
        (edge === 'properties' || (Array.isArray(collection) && /^(0|[1-9][0-9]*)$/.test(key))) &&
        Object.hasOwn(collection, key)
      )
        next = (collection as Record<string, unknown>)[key];
    } else if (edge === 'items' || edge === 'additionalProperties') {
      if (Object.hasOwn(current, edge)) next = current[edge];
    }
    if (!next || typeof next !== 'object' || Array.isArray(next))
      throw new Error('Unknown Google schema field');
    current = next as DiscoverySchema;
  }
  return current;
}

export function schemaField(service: string, path: string, schema: DiscoverySchema) {
  const references = new Set<string>();
  const visit = (node: DiscoverySchema) => {
    if (node.$ref) references.add(`${service}#${node.$ref}`);
    for (const value of Object.values(node.properties ?? {})) visit(value);
    if (node.items) visit(node.items);
    if (node.additionalProperties && typeof node.additionalProperties === 'object')
      visit(node.additionalProperties);
    if (Array.isArray(node.anyOf)) node.anyOf.forEach(visit);
  };
  visit(schema);
  return { path, schema, references: [...references] };
}
