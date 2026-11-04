import type { DiscoveryDocument, DiscoverySchema, MethodMetadata } from './discovery.ts';

// Descriptions are generated for one method and only its referenced types.
// Native Discovery remains the source for runtime validation and dispatch.
export function methodDeclaration(document: DiscoveryDocument, method: MethodMetadata): string {
  const definitions = new Map<string, DiscoverySchema>();
  const typeName = (name: string) => `Google_${name.replace(/[^A-Za-z0-9_$]/g, '_')}`;
  function render(schema: DiscoverySchema, depth = 0): string {
    if (depth > 30) return 'unknown';
    if (schema.repeated) return `Array<${render({ ...schema, repeated: false }, depth + 1)}>`;
    if (schema.$ref) {
      if (!definitions.has(schema.$ref)) {
        definitions.set(schema.$ref, document.schemas?.[schema.$ref] ?? {});
      }
      return typeName(schema.$ref);
    }
    if (Array.isArray(schema.enum))
      return schema.enum.map((v) => JSON.stringify(v)).join(' | ') || 'never';
    switch (schema.type) {
      case 'string':
        return 'string';
      case 'number':
      case 'integer':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'array':
        return `Array<${render(schema.items ?? {}, depth + 1)}>`;
      case 'object': {
        const properties = Object.entries(schema.properties ?? {}).map(
          ([name, value]) =>
            `${JSON.stringify(name)}${value.required ? '' : '?'}: ${render(value, depth + 1)};`,
        );
        if (schema.additionalProperties !== false) {
          properties.push(
            `[key: string]: ${typeof schema.additionalProperties === 'object' ? render(schema.additionalProperties, depth + 1) : 'unknown'};`,
          );
        }
        return `{ ${properties.join(' ')} }`;
      }
      default:
        return 'unknown';
    }
  }
  const parameters = Object.fromEntries(
    Object.entries(method.parameters ?? {}).filter(
      ([name]) =>
        !/^(key|access_token|oauth_token|alt|callback|uploadType|upload_protocol)$/.test(name),
    ),
  );
  const params = render({
    type: 'object',
    properties: { ...parameters, ...(method.request ? { requestBody: method.request } : {}) },
    additionalProperties: false,
  });
  const response = method.response ? render(method.response) : 'null';
  // Iterating the map also visits references added by rendering earlier definitions.
  const aliases: string[] = [];
  for (const [name, schema] of definitions)
    aliases.push(`type ${typeName(name)} = ${render(schema)};`);
  return [
    ...aliases,
    `type Params = ${params};`,
    `type Data = ${response};`,
    `// ${method.path}`,
    `declare const method: { ${JSON.stringify(method.path.split('.').at(-1))}(params: Params): Promise<{data: Data; status: number; headers: Record<string,string>}> };`,
  ].join('\n');
}
