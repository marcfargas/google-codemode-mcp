/** Trusted service identities and destinations; methods remain Discovery-owned. */
export const SERVICES = Object.freeze({
  'gmail/v1': Object.freeze({
    name: 'gmail',
    version: 'v1',
    discoveryUrl: 'https://gmail.googleapis.com/$discovery/rest?version=v1',
    roots: Object.freeze(['gmail.googleapis.com', 'www.googleapis.com']),
    documentationRoot: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1',
  }),
  'drive/v3': Object.freeze({
    name: 'drive',
    version: 'v3',
    discoveryUrl: 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
    roots: Object.freeze(['www.googleapis.com']),
    documentationRoot: 'https://developers.google.com/workspace/drive/api/reference/rest/v3',
  }),
});

export type ServicePath = keyof typeof SERVICES;

export function servicePath(path: string): ServicePath {
  const candidate = path.split(/[\/#]/).slice(0, 2).join('/');
  if (!Object.hasOwn(SERVICES, candidate)) throw new Error('Unsupported Google service');
  return candidate as ServicePath;
}
