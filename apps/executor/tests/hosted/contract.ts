export const HARNESS_VERSION = 2;
export const SYNTHETIC_TOKEN = 'hosted-verification-synthetic-token';
export const PROTOCOL_VERSION = '2026-07-28';
export const PROBE_NAMES = [
  'identity',
  'cpu',
  'asyncTimeout',
  'delayed',
  'unawaited',
  'multiple',
  'mutationUnknown',
  'mutationAcknowledged',
  'isolation',
  'healthy',
] as const;
export type Probe = (typeof PROBE_NAMES)[number];
