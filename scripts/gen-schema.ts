// Emits schema/tether.schema.json: every method, notification and server request, with shared $defs.
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Methods, Notifications, PROTOCOL_VERSION, ServerRequests } from '../src/protocol/index.ts';

const defs: Record<string, unknown> = {};

function convert(schema: z.ZodType): unknown {
  const js = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'output' }) as Record<string, any>;
  for (const [k, v] of Object.entries(js.$defs ?? {})) defs[k] = v;
  delete js.$defs;
  delete js.$schema;
  return js;
}

const doc = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Tether protocol',
  protocolVersion: PROTOCOL_VERSION,
  methods: Object.fromEntries(
    Object.entries(Methods).map(([name, m]) => [name, { params: convert(m.params), result: convert(m.result) }]),
  ),
  notifications: Object.fromEntries(Object.entries(Notifications).map(([name, s]) => [name, convert(s)])),
  serverRequests: Object.fromEntries(
    Object.entries(ServerRequests).map(([name, m]) => [name, { params: convert(m.params), result: convert(m.result) }]),
  ),
  $defs: defs,
};

const out = process.argv[2] ?? 'schema/tether.schema.json';
mkdirSync(out.split('/').slice(0, -1).join('/') || '.', { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${out}: ${Object.keys(doc.methods).length} methods, ${Object.keys(doc.notifications).length} notifications, ${Object.keys(doc.serverRequests).length} server requests, ${Object.keys(defs).length} shared types`);
