// Public API docs: OpenAPI 3.1 document generated from the live Fastify route table.
import type { FastifyInstance } from 'fastify';
import { routeTable } from './admin-00-core';
import { API_URL } from '../core/settings';

const AREA_BY_PREFIX: [RegExp, string][] = [
  [/^\/api\/v1\/(auth|me)\b/, 'Auth & profile'],
  [/^\/api\/v1\/(leads|companies|contacts|opportunities|tasks|activities)\b/, 'CRM'],
  [/^\/api\/v1\/(positions|candidates|applications|submissions|interviews|assessments|assessment-templates|offers|ai|sourcing|recruiting)\b/, 'Recruiting'],
  [/^\/api\/v1\/(workers|placements|onboarding|issues|equipment-templates|time|timesheets)\b/, 'Workforce & time'],
  [/^\/api\/v1\/(finance|rates|invoices|payments|credit-notes|payroll|payouts|commissions|margin|accounting)\b/, 'Finance'],
  [/^\/api\/v1\/(dashboard|analytics|reports|automations|messages|threads|templates|notification-preferences|documents|document-templates|signatures|search)\b/, 'Insights & operations'],
  [/^\/api\/v1\/(settings|team|roles|invitations|integrations|billing|custom-fields|imports|api-keys|webhooks|audit|support|docs)\b/, 'Admin'],
  [/^\/api\/v1\/platform\b/, 'Platform'],
  [/^\/api\/v1\/portal\/client\b/, 'Client portal'],
  [/^\/api\/v1\/portal\/worker\b/, 'Worker portal'],
  [/^\/api\/v1\/portal\/candidate\b/, 'Candidate portal'],
  [/^\/api\/v1\/public\b/, 'Public'],
];
const tagFor = (url: string) => AREA_BY_PREFIX.find(([re]) => re.test(url))?.[1] ?? 'Core';
const human = (s: string) => s.replace(/[-_]/g, ' ');

function summaryFor(method: string, url: string) {
  const segs = url.replace(/^\/api\/v1\//, '').split('/');
  const last = segs[segs.length - 1];
  const isParam = last.startsWith(':');
  const resource = human(segs.filter(s => !s.startsWith(':')).slice(-1)[0] ?? 'resource');
  if (method === 'GET') return isParam ? `Get ${resource.replace(/s$/, '')}` : `List ${resource}`;
  if (method === 'POST') return isParam ? `Act on ${resource}` : segs.length > 1 && segs.slice(0, -1).some(s => s.startsWith(':')) ? `${human(last).replace(/^\w/, c => c.toUpperCase())}` : `Create ${resource.replace(/s$/, '')}`;
  if (method === 'PATCH' || method === 'PUT') return `Update ${resource.replace(/s$/, '')}`;
  if (method === 'DELETE') return `Delete ${resource.replace(/s$/, '')}`;
  return `${method} ${url}`;
}

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routeTable()) {
    if (r.url.includes('*') || r.url.startsWith('/api/v1/dev/') || r.url === '/api/v1/stream') continue;
    const oaPath = r.url.replace(/:(\w+)/g, '{$1}');
    const params = [...r.url.matchAll(/:(\w+)/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const op: Record<string, unknown> = {
      tags: [tagFor(r.url)],
      summary: summaryFor(r.method, r.url),
      operationId: `${r.method.toLowerCase()}_${r.url.replace(/^\/api\/v1\//, '').replace(/[/:-]+/g, '_')}`,
      parameters: [...params, ...(r.method === 'GET' && !r.url.endsWith('}') && !/:\w+$/.test(r.url) ? [
        { name: 'search', in: 'query', schema: { type: 'string' } }, { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
        { name: 'pageSize', in: 'query', schema: { type: 'integer', maximum: 500 } }, { name: 'sort', in: 'query', schema: { type: 'string' } }, { name: 'dir', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
      ] : [])],
      responses: {
        200: { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } },
        400: { $ref: '#/components/responses/ValidationError' }, 401: { $ref: '#/components/responses/Unauthorized' },
        403: { $ref: '#/components/responses/Forbidden' }, 404: { $ref: '#/components/responses/NotFound' }, 409: { $ref: '#/components/responses/Conflict' }, 429: { $ref: '#/components/responses/RateLimited' },
      },
    };
    if (['POST', 'PUT', 'PATCH'].includes(r.method)) op.requestBody = { required: false, content: { 'application/json': { schema: { type: 'object' } } } };
    if (r.public) op.security = [];
    (paths[oaPath] ??= {})[r.method.toLowerCase()] = op;
  }
  const err = (d: string) => ({ description: d, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
  return {
    openapi: '3.1.0',
    info: { title: 'VeyroApp API', version: 'v1', description: 'Versioned REST API for VeyroApp. Authenticate with an API key (Settings → API & Webhooks) as `Authorization: Bearer vk_…`. Keys act within their own workspace with the permissions of the user who created them, and are rate-limited to 120 requests/minute. Lists return `{ rows, total, page, pageSize }`. Money is integer cents with a currency.' },
    servers: [{ url: API_URL }],
    tags: [...new Set(Object.values(paths).flatMap(p => Object.values(p).map((o: any) => o.tags[0])))].sort().map(name => ({ name })),
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'vk_…' }, session: { type: 'apiKey', in: 'cookie', name: 'vsid' } },
      schemas: { Error: { type: 'object', properties: { error: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'string' } }, details: {} }, required: ['error'] } },
      responses: { ValidationError: err('Validation failed'), Unauthorized: err('Missing or invalid credentials'), Forbidden: err('Not permitted for this role'), NotFound: err('Not found (also returned for records in other workspaces)'), Conflict: err('Invalid state transition or duplicate'), RateLimited: err('Too many requests') },
    },
    security: [{ apiKey: [] }, { session: [] }],
    paths,
  };
}

export default async function (app: FastifyInstance) {
  app.get('/api/v1/docs/openapi.json', { config: { public: true } }, async () => buildOpenApi());
}
