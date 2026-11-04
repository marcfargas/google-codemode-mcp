import type { Schema } from '@cfworker/json-schema';
import { methodDeclaration } from './declarations.ts';

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
}

export const GMAIL_DISCOVERY_URL = 'https://gmail.googleapis.com/$discovery/rest?version=v1';

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
  private loaded?: Promise<DiscoveryDocument>;
  private current?: DiscoveryDocument;

  get provenance() {
    return this.current
      ? {
          service: this.current.name,
          version: this.current.version,
          revision: this.current.revision ?? null,
          source: GMAIL_DISCOVERY_URL,
        }
      : null;
  }
  private readonly options: { document?: DiscoveryDocument; fetch?: typeof fetch };

  constructor(options: { document?: DiscoveryDocument; fetch?: typeof fetch } = {}) {
    this.options = options;
  }

  document(): Promise<DiscoveryDocument> {
    this.loaded ??= this.load().catch((error: unknown) => {
      this.loaded = undefined;
      throw error;
    });
    return this.loaded;
  }

  private async load(): Promise<DiscoveryDocument> {
    let document = this.options.document;
    if (!document) {
      const response = await (this.options.fetch ?? fetch)(GMAIL_DISCOVERY_URL, {
        redirect: 'manual',
      });
      if (!response.ok) throw new Error('Google Discovery unavailable');
      document = (await response.json()) as DiscoveryDocument;
    }
    if (document.name !== 'gmail' || document.version !== 'v1') {
      throw new Error('Only Gmail v1 is supported');
    }
    const root = new URL(document.rootUrl);
    if (
      root.protocol !== 'https:' ||
      !['gmail.googleapis.com', 'www.googleapis.com'].includes(root.hostname) ||
      root.port ||
      root.username ||
      root.password ||
      root.search ||
      root.hash ||
      root.pathname !== '/' ||
      /^\/|\.{2}|[:?#]/.test(document.servicePath)
    )
      throw new Error('Untrusted Discovery destination');
    this.current = document;
    return document;
  }

  private async methods(): Promise<Map<string, MethodMetadata>> {
    const document = await this.document();
    const found = new Map<string, MethodMetadata>();
    const visit = (resource: DiscoveryResource, prefix: string[]) => {
      for (const [name, method] of Object.entries(resource.methods ?? {})) {
        const path = `gmail/v1/${[...prefix, name].join('.')}`;
        found.set(path, {
          ...method,
          path,
          httpPath: method.path,
          httpMethod: method.httpMethod.toUpperCase(),
          mutation: !['GET', 'HEAD'].includes(method.httpMethod.toUpperCase()),
          parameters: { ...document.parameters, ...method.parameters },
        });
      }
      for (const [name, child] of Object.entries(resource.resources ?? {})) {
        visit(child, [...prefix, name]);
      }
    };
    visit(document, []);
    return found;
  }

  async resolve(path: string): Promise<MethodMetadata> {
    const method = (await this.methods()).get(path);
    if (!method) throw new Error('Unknown Google method');
    return method;
  }

  async describe(path = ''): Promise<Record<string, unknown>> {
    if (!path) return { services: [{ name: 'gmail', versions: ['v1'] }] };
    if (path === 'gmail') return { service: 'gmail', versions: ['v1'] };
    const document = await this.document();
    const methods = await this.methods();
    const method = methods.get(path);
    if (method) {
      return {
        ...method,
        revision: document.revision,
        source: GMAIL_DISCOVERY_URL,
        declarations: methodDeclaration(document, method),
        skill: 'skill://google-codemode-mcp/google-workspace/SKILL.md',
        documentation: `https://developers.google.com/workspace/gmail/api/reference/rest/v1/${path.slice('gmail/v1/'.length).split('.').slice(0, -1).join('.')}/${path.split('.').at(-1)}`,
        signature: `${path.slice('gmail/v1/'.length)}(params): Promise<{ data, status, headers }>`,
        authorization: 'unknown',
        scopesSemantics: 'alternatives',
        runtime: { json: true, mediaUpload: false, mediaDownload: false },
        requestSchema: method.request ? this.schemaFor(document, method.request) : undefined,
        responseSchema: method.response ? this.schemaFor(document, method.response) : undefined,
      };
    }
    if (path.startsWith('gmail/v1#')) {
      const name = path.slice('gmail/v1#'.length);
      if (!document.schemas?.[name]) throw new Error('Unknown Google schema');
      return { path, schema: this.schemaFor(document, { $ref: name }) };
    }
    const prefix = path === 'gmail/v1' ? '' : path.slice('gmail/v1/'.length) + '.';
    if (path !== 'gmail/v1' && !path.startsWith('gmail/v1/')) {
      throw new Error('Unknown discovery path');
    }
    const matching = [...methods.values()].filter((value) =>
      value.path.slice(9).startsWith(prefix),
    );
    if (!matching.length) throw new Error('Unknown discovery path');
    const resources = new Set<string>();
    const direct: { path: string; description?: string; mutation: boolean }[] = [];
    for (const entry of matching) {
      const suffix = entry.path.slice(9 + prefix.length);
      if (suffix.includes('.')) resources.add(prefix + suffix.split('.')[0]);
      else
        direct.push({ path: entry.path, description: entry.description, mutation: entry.mutation });
    }
    return {
      path,
      revision: document.revision,
      source: GMAIL_DISCOVERY_URL,
      resources: [...resources].map((name) => `gmail/v1/${name}`),
      methods: direct,
      schemaPath: 'gmail/v1#<SchemaName>',
    };
  }

  private schemaFor(document: DiscoveryDocument, schema: DiscoverySchema): Schema {
    return {
      ...jsonSchema(schema),
      definitions: referencedDefinitions(document, [schema]),
    };
  }
}
