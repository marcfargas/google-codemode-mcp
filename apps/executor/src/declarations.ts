import type { DiscoveryDocument, DiscoverySchema, MethodMetadata } from './discovery.ts';
import { callableParameters, supportsDownload } from './parameters.ts';
import { supportsUpload, GMAIL_DRAFT_MEDIA_REQUEST } from './media.ts';

// Descriptions are generated for one method and only its referenced types.
// Native Discovery remains the source for runtime validation and dispatch.
export function methodDeclaration(
  document: DiscoveryDocument,
  method: MethodMetadata,
  streamMedia = false,
): string {
  const projection = callableParameters(method, streamMedia);
  if (!method.supported || !projection.supported)
    return `// ${method.path}: unsupported by the execution parameter policy`;
  const definitions = new Map<string, DiscoverySchema>();
  const typeName = (name: string) => `Google_${name.replace(/[^A-Za-z0-9_$]/g, '_')}`;
  function render(schema: DiscoverySchema, depth = 0): string {
    if (depth > 30) return 'unknown';
    if (Array.isArray(schema.anyOf))
      return (schema.anyOf as DiscoverySchema[])
        .map((option) => render(option, depth + 1))
        .join(' | ');
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
  const params = render({
    type: 'object',
    properties: {
      ...projection.parameters,
      ...(method.request ? { requestBody: method.request } : {}),
    },
    additionalProperties: false,
  });
  const download = supportsDownload(method);
  const mediaType = streamMedia ? 'GoogleMediaArtifact' : 'GoogleMediaBytes';
  const response = method.response ? render(method.response) : download ? mediaType : 'null';
  // Iterating the map also visits references added by rendering earlier definitions.
  const aliases: string[] = [];
  for (const [name, schema] of definitions)
    aliases.push(`type ${typeName(name)} = ${render(schema)};`);
  const name = JSON.stringify(method.path.split('/').at(-1)!.split('.').at(-1));
  const result = (data: string) =>
    `Promise<{data: ${data}; status: number; headers: Record<string,string>}>`;
  const signatures = download
    ? method.response
      ? `${name}(params: Omit<Params, 'alt'> & {alt: 'media'}): ${result(mediaType)}; ${name}(params: Omit<Params, 'alt'> & {alt?: 'json'}): ${result('Data')}; ${name}(params: Params): ${result('Data | ' + mediaType)};`
      : `${name}(params: Params): ${result(mediaType)};`
    : supportsUpload(method)
      ? `${name}(params: Omit<Params, 'media'> & {media?: never}): ${result('Data')}; ${name}(params: Omit<Params, 'requestBody'> & {media: NonNullable<Params['media']>; requestBody: ${method.path === 'gmail/v1/users.drafts.create' ? render(GMAIL_DRAFT_MEDIA_REQUEST) : "NonNullable<Params['requestBody']>"}}): ${result('Data')};`
      : `${name}(params: Params): ${result('Data')};`;
  return [
    ...aliases,
    ...(download
      ? [
          streamMedia
            ? "type GoogleMediaArtifact = { uri: string; kind: 'bytes'; size: number; mimeType: string; sha256: string; complete: true; createdAt: number; expiresAt: number };"
            : "type GoogleMediaBytes = { encoding: 'base64'; data: string; size: number; mimeType: string; sha256: string };",
        ]
      : []),
    `type Params = ${params};`,
    `type Data = ${response};`,
    `// ${method.path}`,
    `declare const method: { ${signatures} };`,
  ].join('\n');
}
