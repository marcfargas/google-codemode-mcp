import type { DiscoverySchema } from './discovery.ts';
import { supportsUpload, uploadSchema } from './media.ts';

interface ParameterMethod {
  path?: string;
  parameters?: Record<string, DiscoverySchema>;
  parameterOrder?: string[];
  supportsMediaDownload?: boolean;
  httpMethod?: string;
  response?: DiscoverySchema;
  supportsMediaUpload?: boolean;
  mediaUpload?: unknown;
}

export function supportsDownload(method: ParameterMethod): boolean {
  return method.supportsMediaDownload === true && method.httpMethod?.toUpperCase() === 'GET';
}

export interface ExcludedParameter {
  name: string;
  reason: 'credentials_or_transport' | 'sdk_alias';
  required: boolean;
}

const reserved =
  /^(auth|headers|rootUrl|url|options|retry|retryConfig|adapter|fetchImplementation|accessToken|oauth_token|access_token|key|resource|media|uploadType|upload_protocol|callback|alt)_*$/i;

/** This policy applies to native top-level parameters, never request-body fields. */
export function parameterExclusion(name: string): ExcludedParameter['reason'] | undefined {
  if (reserved.test(name)) return 'credentials_or_transport';
  // googleapis unaliases trailing underscores after extracting auth/headers.
  if (name.endsWith('_')) return 'sdk_alias';
  return undefined;
}

export function callableParameters(method: ParameterMethod, artifactUploads = true) {
  const parameters: Record<string, DiscoverySchema> = Object.create(null);
  const excludedParameters: ExcludedParameter[] = [];
  for (const [name, schema] of Object.entries(method.parameters ?? {})) {
    if (name === 'media' && supportsUpload(method)) continue;
    if (name === 'alt' && supportsDownload(method)) {
      parameters.alt = {
        ...schema,
        type: 'string',
        enum: method.response ? ['json', 'media'] : ['media'],
        default: method.response ? 'json' : 'media',
      };
      continue;
    }
    const reason = parameterExclusion(name);
    if (reason) excludedParameters.push({ name, reason, required: schema.required === true });
    else parameters[name] = schema;
  }
  if (supportsUpload(method)) parameters.media = uploadSchema(artifactUploads);
  return {
    parameters,
    excludedParameters,
    parameterOrder: method.parameterOrder?.filter((name) => Object.hasOwn(parameters, name)),
    supported: !excludedParameters.some((parameter) => parameter.required),
  };
}
