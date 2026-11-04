import type { Schema } from '@cfworker/json-schema';
import { methodDeclaration } from './declarations.ts';
import { callableParameters, supportsDownload } from './parameters.ts';
import { SERVICES, servicePath } from './services.ts';
import type { ServicePath } from './services.ts';
import type { ExcludedParameter } from './parameters.ts';

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

/** Convert Google's Discovery schema dialect without closing extensible bodies. */
export function jsonSchema(source: DiscoverySchema): Schema {
  const target: Schema = {};
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

  async describe(path = ''): Promise<Record<string, unknown>> {
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
    const methods = await this.methods(key);
    const method = methods.get(path);
    if (method) {
      const download = method.supported && supportsDownload(method);
      const localPath = path.slice(key.length + 1);
      const separator = localPath.lastIndexOf('.');
      return {
        ...method,
        revision: document.revision,
        source: service.discoveryUrl,
        declarations: method.supported ? methodDeclaration(document, method) : undefined,
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
          mediaUpload: false,
          mediaDownload: download,
          ...(download
            ? {
                maxDownloadBytes: MAX_DOWNLOAD_BYTES,
                mediaSelection: method.response ? "alt: 'media'" : 'always',
              }
            : {}),
        },
        mediaResponseSchema: download ? MEDIA_SCHEMA : undefined,
        requestSchema: method.request ? this.schemaFor(document, method.request) : undefined,
        responseSchema: method.response ? this.schemaFor(document, method.response) : undefined,
      };
    }
    if (path.startsWith(`${key}#`)) {
      const name = path.slice(key.length + 1);
      if (!document.schemas?.[name]) throw new Error('Unknown Google schema');
      return { path, schema: this.schemaFor(document, { $ref: name }) };
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
      schemaPath: `${key}#<SchemaName>`,
    };
  }

  private schemaFor(document: DiscoveryDocument, schema: DiscoverySchema): Schema {
    return { ...jsonSchema(schema), definitions: referencedDefinitions(document, [schema]) };
  }
}
