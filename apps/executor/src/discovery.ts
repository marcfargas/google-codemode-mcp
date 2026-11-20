import type { Schema } from '@cfworker/json-schema';
import { methodDeclaration } from './declarations.ts';
import {
  methodSummary,
  parameterBrief,
  schemaField,
  schemaInventory,
  schemaSummary,
  selectSchemaNode,
} from './discovery-brief.ts';
import { callableParameters, supportsDownload } from './parameters.ts';
import {
  supportsUpload,
  MEDIA_SKILL_URI,
  MAX_UPLOAD_BYTES,
  MAX_EXECUTION_UPLOAD_BYTES,
  MAX_UPLOAD_METADATA_BYTES,
  MAX_UPLOAD_PARAMS_BYTES,
  MAX_UPLOAD_WIRE_BYTES,
  maxArtifactUploadBytes,
  GMAIL_DRAFT_MEDIA_REQUEST,
} from './media.ts';
import { SERVICES, servicePath } from './services.ts';
import type { ServicePath } from './services.ts';
import type { ExcludedParameter } from './parameters.ts';
import { MAX_STREAM_BYTES } from './storage.ts';

export interface DiscoverySchema {
  type?: string;
  $ref?: string;
  description?: string;
  required?: boolean;
  repeated?: boolean;
  properties?: Record<string, DiscoverySchema>;
  items?: DiscoverySchema;
  additionalProperties?: DiscoverySchema | boolean;
  [key: string]: unknown;
}

export interface DiscoveryMethod {
  id?: string;
  description?: string;
  path: string;
  httpMethod: string;
  parameters?: Record<string, DiscoverySchema>;
  parameterOrder?: string[];
  request?: DiscoverySchema;
  response?: DiscoverySchema;
  scopes?: string[];
  supportsMediaUpload?: boolean;
  supportsMediaDownload?: boolean;
  [key: string]: unknown;
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

export interface DiscoveryDocument extends DiscoveryResource {
  [key: string]: unknown;
  name: string;
  version: string;
  revision?: string;
  rootUrl: string;
  servicePath: string;
  parameters?: Record<string, DiscoverySchema>;
  schemas?: Record<string, DiscoverySchema>;
}

export interface MethodMetadata extends DiscoveryMethod {
  /** Canonical discovery path, rather than the HTTP path. */
  path: string;
  httpPath: string;
  mutation: boolean;
  supported: boolean;
  excludedParameters: ExcludedParameter[];
}

export const GMAIL_DISCOVERY_URL = SERVICES['gmail/v1'].discoveryUrl;
export const MAX_DOWNLOAD_BYTES = 128 * 1024;
export type DiscoveryView = 'brief' | 'full';
const CONVENTIONS_URI = 'skill://google-codemode-mcp/google-workspace/references/conventions.md';
const DISCOVERY_NEXT =
  "Before execute, describe every distinct Google method the program may call, including calls inside helpers, loops and branches. A resource listing or another method's schemas do not describe that method. Reuse method descriptions already read in this conversation.";
export const MEDIA_SCHEMA = {
  type: 'object',
  required: ['encoding', 'data', 'size', 'mimeType', 'sha256'],
  properties: {
    encoding: { const: 'base64' },
    data: { type: 'string' },
    size: { type: 'integer', maximum: MAX_DOWNLOAD_BYTES },
    mimeType: { type: 'string' },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
};
const MEDIA_ARTIFACT_SCHEMA = {
  type: 'object',
  required: ['uri', 'kind', 'size', 'mimeType', 'sha256', 'complete', 'createdAt', 'expiresAt'],
  properties: {
    uri: { type: 'string', pattern: '^artifact://google-codemode-mcp/v2/[A-Za-z0-9_-]{43}$' },
    kind: { const: 'bytes' },
    size: { type: 'integer', maximum: MAX_STREAM_BYTES },
    mimeType: { type: 'string' },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    complete: { const: true },
    createdAt: { type: 'integer' },
    expiresAt: { type: 'integer' },
  },
};

/** Convert Google's Discovery schema dialect without closing extensible bodies. */
export function jsonSchema(source: DiscoverySchema): Schema {
  const target: Schema = {};
  if (Array.isArray(source.anyOf)) target.anyOf = source.anyOf.map(jsonSchema);
  if (source.$ref) target.$ref = `#/definitions/${source.$ref}`;
  if (source.type) target.type = source.type as Schema['type'];
  if (source.description) target.description = source.description;
  if (Array.isArray(source.enum)) target.enum = source.enum;
  if (typeof source.pattern === 'string') target.pattern = source.pattern;
  for (const name of ['minimum', 'maximum'] as const) {
    if (source[name] !== undefined && Number.isFinite(Number(source[name]))) {
      target[name] = Number(source[name]);
    }
  }
  if (source.properties) {
    target.properties = Object.fromEntries(
      Object.entries(source.properties).map(([name, value]) => [name, jsonSchema(value)]),
    );
    const required = Object.entries(source.properties)
      .filter(([, value]) => value.required)
      .map(([name]) => name);
    if (required.length) target.required = required;
  }
  if (source.items) target.items = jsonSchema(source.items);
  if (source.additionalProperties !== undefined) {
    target.additionalProperties =
      typeof source.additionalProperties === 'boolean'
        ? source.additionalProperties
        : jsonSchema(source.additionalProperties);
  }
  if (source.repeated) return { type: 'array', items: target };
  return target;
}

/** Only retain schemas transitively referenced by the requested surface. */
export function referencedDefinitions(
  document: DiscoveryDocument,
  sources: DiscoverySchema[],
): Record<string, Schema> {
  const definitions: Record<string, Schema> = Object.create(null);
  const visit = (source: DiscoverySchema) => {
    if (source.$ref && !Object.hasOwn(definitions, source.$ref)) {
      const referenced = document.schemas?.[source.$ref];
      if (!referenced) throw new Error('Unresolved Google schema reference');
      definitions[source.$ref] = jsonSchema(referenced);
      visit(referenced);
    }
    for (const value of Object.values(source.properties ?? {})) visit(value);
    if (source.items) visit(source.items);
    if (source.additionalProperties && typeof source.additionalProperties === 'object')
      visit(source.additionalProperties);
  };
  sources.forEach(visit);
  return definitions;
}

export class DiscoveryCatalog {
  private readonly loaded = new Map<ServicePath, Promise<DiscoveryDocument>>();
  private readonly current = new Map<ServicePath, DiscoveryDocument>();
  private readonly options: {
    document?: DiscoveryDocument;
    documents?: Partial<Record<ServicePath, DiscoveryDocument>>;
    fetch?: typeof fetch;
  };

  get provenance() {
    return this.current.size
      ? [...this.current.entries()].map(([key, document]) => ({
          service: document.name,
          version: document.version,
          revision: document.revision ?? null,
          source: SERVICES[key].discoveryUrl,
        }))
      : null;
  }

  constructor(
    options: {
      document?: DiscoveryDocument;
      documents?: Partial<Record<ServicePath, DiscoveryDocument>>;
      fetch?: typeof fetch;
    } = {},
  ) {
    this.options = options;
  }

  document(key: string = 'gmail/v1'): Promise<DiscoveryDocument> {
    const selected = servicePath(key);
    if (selected !== key) return Promise.reject(new Error('Expected a service/version path'));
    let pending = this.loaded.get(selected);
    if (!pending) {
      pending = this.load(selected).catch((error: unknown) => {
        this.loaded.delete(selected);
        throw error;
      });
      this.loaded.set(selected, pending);
    }
    return pending;
  }

  private async load(key: ServicePath): Promise<DiscoveryDocument> {
    const service = SERVICES[key];
    let document = this.options.documents?.[key] ?? this.options.document;
    if (!document) {
      const response = await (this.options.fetch ?? fetch)(service.discoveryUrl, {
        redirect: 'manual',
      });
      if (!response.ok) throw new Error('Google Discovery unavailable');
      document = (await response.json()) as DiscoveryDocument;
    }
    if (document.name !== service.name || document.version !== service.version)
      throw new Error('Unexpected Google service identity');
    const root = new URL(document.rootUrl);
    if (
      root.protocol !== 'https:' ||
      !service.roots.some((host) => host === root.hostname) ||
      root.port ||
      root.username ||
      root.password ||
      root.search ||
      root.hash ||
      root.pathname !== '/' ||
      /^\/|\.{2}|[:?#]/.test(document.servicePath)
    )
      throw new Error('Untrusted Discovery destination');
    this.current.set(key, document);
    return document;
  }

  private async methods(key: ServicePath): Promise<Map<string, MethodMetadata>> {
    const document = await this.document(key);
    const found = new Map<string, MethodMetadata>();
    const visit = (resource: DiscoveryResource, prefix: string[]) => {
      for (const [name, method] of Object.entries(resource.methods ?? {})) {
        const path = `${key}/${[...prefix, name].join('.')}`;
        found.set(path, {
          ...method,
          path,
          httpPath: method.path,
          httpMethod: method.httpMethod.toUpperCase(),
          mutation: !['GET', 'HEAD'].includes(method.httpMethod.toUpperCase()),
          ...callableParameters({
            ...method,
            path,
            parameters: { ...document.parameters, ...method.parameters },
          }),
        });
      }
      for (const [name, child] of Object.entries(resource.resources ?? {}))
        visit(child, [...prefix, name]);
    };
    visit(document, []);
    return found;
  }

  async resolve(path: string): Promise<MethodMetadata> {
    const method = (await this.methods(servicePath(path))).get(path);
    if (!method) throw new Error('Unknown Google method');
    return method;
  }

  async describe(
    path = '',
    options: { streamMedia?: boolean; view?: DiscoveryView } = {},
  ): Promise<Record<string, unknown>> {
    const navigationError = () =>
      new Error('Unknown discovery path. Call describe({}) and follow its returned paths.');
    if (!path)
      return {
        services: Object.entries(SERVICES).map(([key, service]) => ({
          name: service.name,
          versions: [service.version],
          paths: [key],
        })),
        next: 'Read the skill URI through MCP Resources, then follow service and resource paths with describe to each needed method for its signature and schemas before execute.',
        skill: 'skill://google-codemode-mcp/google-workspace/SKILL.md',
        conventions: CONVENTIONS_URI,
      };
    const entries = Object.entries(SERVICES).filter(([, service]) => service.name === path);
    if (entries.length)
      return {
        service: path,
        versions: entries.map(([, service]) => service.version),
        paths: entries.map(([key]) => key),
      };
    let key: ServicePath;
    try {
      key = servicePath(path);
    } catch {
      throw navigationError();
    }
    if (path !== key && !path.startsWith(`${key}/`) && !path.startsWith(`${key}#`))
      throw navigationError();
    const service = SERVICES[key];
    const document = await this.document(key);
    const provenance = { revision: document.revision, source: service.discoveryUrl };
    const commonPath = `${key}/@parameters`;
    if (path === commonPath)
      return {
        path,
        ...provenance,
        parameters: callableParameters({ parameters: document.parameters }).parameters,
        conventions: CONVENTIONS_URI,
      };
    if (path.startsWith(`${key}#`)) {
      const fragment = path.slice(key.length + 1);
      const slash = fragment.indexOf('/');
      const name = slash === -1 ? fragment : fragment.slice(0, slash);
      if (!document.schemas || !Object.hasOwn(document.schemas, name))
        throw new Error('Unknown Google schema');
      const schema = document.schemas[name];
      if (slash !== -1)
        return {
          ...schemaField(key, path, selectSchemaNode(schema, fragment.slice(slash + 1))),
          ...provenance,
        };
      if (options.view === 'full')
        return { path, schema: this.schemaFor(document, { $ref: name }) };
      return {
        path,
        view: 'brief',
        ...provenance,
        schema: schemaInventory(key, path, schema),
        full: { path, view: 'full' },
      };
    }
    const methods = await this.methods(key);
    const method = methods.get(path);
    if (method) {
      const download = method.supported && supportsDownload(method);
      const upload = method.supported && supportsUpload(method);
      const localPath = path.slice(key.length + 1);
      const separator = localPath.lastIndexOf('.');
      const { parameters } = callableParameters(method, !!options.streamMedia);
      const contract = {
        skill: 'skill://google-codemode-mcp/google-workspace/SKILL.md',
        documentation: `${service.documentationRoot}/${separator < 0 ? localPath : localPath.slice(0, separator) + '/' + localPath.slice(separator + 1)}`,
        signature: method.supported
          ? `${path.slice(key.length + 1)}(params): Promise<{ data, status, headers }>`
          : undefined,
        unsupportedReason: method.supported
          ? undefined
          : 'A required native parameter is excluded by the execution parameter policy',
        authorization: 'unknown',
        scopesSemantics: 'alternatives',
        runtime: {
          json: method.supported && (!download || !!method.response),
          maxParameterBytes: MAX_UPLOAD_PARAMS_BYTES,
          mediaUpload: upload,
          mediaDownload: download,
          ...(upload
            ? {
                uploadSelection: 'media with requestBody; multipart only',
                maxUploadBytes: MAX_UPLOAD_BYTES,
                maxExecutionUploadBytes: MAX_EXECUTION_UPLOAD_BYTES,
                maxUploadMetadataBytes: MAX_UPLOAD_METADATA_BYTES,
                maxUploadParamsBytes: MAX_UPLOAD_PARAMS_BYTES,
                maxUploadWireBytes: MAX_UPLOAD_WIRE_BYTES,
                artifactUpload: !!options.streamMedia,
                ...(options.streamMedia
                  ? { maxArtifactUploadBytes: maxArtifactUploadBytes(method) }
                  : {}),
                ...(path === 'gmail/v1/users.drafts.create'
                  ? {
                      uploadMimeTypes: ['message/rfc822'],
                      mediaRequestSchema: GMAIL_DRAFT_MEDIA_REQUEST,
                    }
                  : {}),
                skill: MEDIA_SKILL_URI,
              }
            : {}),
          ...(download
            ? {
                maxDownloadBytes: options.streamMedia ? MAX_STREAM_BYTES : MAX_DOWNLOAD_BYTES,
                mediaSelection: method.response ? "alt: 'media'" : 'always',
                ...(options.streamMedia ? { mediaResult: 'artifact-reference' } : {}),
              }
            : {}),
        },
      };
      if (options.view !== 'full') {
        const shared = callableParameters({ parameters: document.parameters }).parameters;
        const sharedNames: string[] = [];
        const local: Record<string, unknown> = Object.create(null);
        for (const [name, schema] of Object.entries(parameters)) {
          const common = shared[name];
          if (schema === common || (common && JSON.stringify(schema) === JSON.stringify(common)))
            sharedNames.push(name);
          else local[name] = parameterBrief(key, schema);
        }
        return {
          path,
          view: 'brief',
          summary: methodSummary(method.description),
          ...contract,
          supported: method.supported,
          mutation: method.mutation,
          httpMethod: method.httpMethod,
          parameters: local,
          commonParameters: sharedNames.length
            ? { path: commonPath, names: sharedNames }
            : undefined,
          requestBody: method.request && schemaSummary(key, method.request),
          response: method.response && schemaSummary(key, method.response),
          runtime: {
            ...contract.runtime,
            ...(download && !options.streamMedia ? { mediaResult: 'inline-base64' } : {}),
          },
          excludedParameters: method.excludedParameters,
          scopes: method.scopes,
          ...provenance,
          full: { path, view: 'full' },
        };
      }
      const described = {
        ...method,
        parameters,
        ...provenance,
        declarations: method.supported
          ? methodDeclaration(document, method, options.streamMedia)
          : undefined,
        ...contract,
        next: DISCOVERY_NEXT,
        mediaResponseSchema: download
          ? options.streamMedia
            ? MEDIA_ARTIFACT_SCHEMA
            : MEDIA_SCHEMA
          : undefined,
        requestSchema: method.request ? this.schemaFor(document, method.request) : undefined,
        responseSchema: method.response ? this.schemaFor(document, method.response) : undefined,
      };
      // Hosts may preview only the beginning of large native method descriptions.
      // Promote guidance without changing any field or its computed value.
      const header = [
        'path',
        'signature',
        'next',
        'supported',
        'mutation',
        'httpMethod',
        'runtime',
        'excludedParameters',
        'unsupportedReason',
        'documentation',
        'skill',
      ] as const;
      return Object.fromEntries([
        ...header.map((name) => [name, described[name]]),
        ...Object.entries(described),
      ]);
    }
    const prefix = path === key ? '' : path.slice(key.length + 1) + '.';
    const matching = [...methods.values()].filter((value) =>
      value.path.slice(key.length + 1).startsWith(prefix),
    );
    if (!matching.length) throw navigationError();
    const resources = new Set<string>();
    const direct: { path: string; description?: string; mutation: boolean }[] = [];
    for (const entry of matching) {
      const suffix = entry.path.slice(key.length + 1 + prefix.length);
      if (suffix.includes('.')) resources.add(prefix + suffix.split('.')[0]);
      else
        direct.push({ path: entry.path, description: entry.description, mutation: entry.mutation });
    }
    return {
      path,
      revision: document.revision,
      source: service.discoveryUrl,
      resources: [...resources].map((name) => `${key}/${name}`),
      methods: direct,
      next: DISCOVERY_NEXT,
      schemaPath: `${key}#<SchemaName>`,
      commonParameters: commonPath,
    };
  }

  private schemaFor(document: DiscoveryDocument, schema: DiscoverySchema): Schema {
    return { ...jsonSchema(schema), definitions: referencedDefinitions(document, [schema]) };
  }
}
