// Generates Sources/TetherProtocol/Generated.swift from schema/tether.schema.json.
// Conventions:
//  - objects → public structs (Codable, Sendable, Hashable) with explicit coding so
//    required-nullable fields encode `null` and optional ones are omitted;
//  - string enums → RawRepresentable structs, so unknown values from newer servers decode;
//  - discriminated unions → enums with an `.unknown(JSONValue)` fallback case;
//  - unknown/any → JSONValue.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

type S = Record<string, any>;
const schemaPath = process.argv[2] ?? 'schema/tether.schema.json';
const outPath = process.argv[3] ?? 'Sources/TetherProtocol/Generated.swift';
const schemaDoc = JSON.parse(readFileSync(schemaPath, 'utf8'));
const defs: Record<string, S> = schemaDoc.$defs;

const KEYWORDS = new Set(
  'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as Any catch false is nil super self Self throw throws true try Type Protocol'.split(
    ' ',
  ),
);
const ident = (n: string) => (KEYWORDS.has(n) ? `\`${n}\`` : n);
const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join('');
const camel = (s: string) => {
  const p = pascal(s);
  return p ? p[0]!.toLowerCase() + p.slice(1) : '_';
};

const out: string[] = [];
const emitted = new Set<string>();

function isNullable(s: S): { inner: S; nullable: boolean } {
  if (Array.isArray(s.type) && s.type.includes('null')) {
    const rest = s.type.filter((t: string) => t !== 'null');
    return { inner: { ...s, type: rest.length === 1 ? rest[0] : rest }, nullable: true };
  }
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(s[key]) && s[key].some((x: S) => x.type === 'null')) {
      const rest = s[key].filter((x: S) => x.type !== 'null');
      return { inner: rest.length === 1 ? rest[0] : { [key]: rest }, nullable: true };
    }
  }
  return { inner: s, nullable: false };
}

function discriminator(s: S): string | undefined {
  const opts: S[] | undefined = s.oneOf ?? s.anyOf;
  if (!opts || opts.length < 1) return;
  const first = opts[0];
  if (first?.type !== 'object') return;
  for (const key of Object.keys(first.properties ?? {})) {
    if (opts.every((o) => o.type === 'object' && o.properties?.[key]?.const !== undefined)) return key;
  }
}

/** Returns the Swift type for a schema, emitting named types as needed. `hint` names inline types. */
function swiftType(s: S, hint: string, indent: string, nested: string[]): string {
  if (s.$ref) {
    const n = s.$ref.split('/').pop()!;
    return n === 'JsonValue' ? 'JSONValue' : n;
  }
  const { inner, nullable } = isNullable(s);
  if (nullable) return `${swiftType(inner, hint, indent, nested)}?`;
  if (s.const !== undefined) return 'String';
  if (s.enum) {
    nested.push(...stringEnum(hint, s.enum, indent));
    return hint;
  }
  if (discriminator(s)) {
    nested.push(...union(hint, s, indent));
    return hint;
  }
  if (s.oneOf || s.anyOf) return 'JSONValue';
  switch (s.type) {
    case 'string':
      return 'String';
    case 'integer':
      return 'Int';
    case 'number':
      return 'Double';
    case 'boolean':
      return 'Bool';
    case 'array':
      return `[${swiftType(s.items ?? {}, singular(hint), indent, nested)}]`;
    case 'object':
      if (!s.properties && s.additionalProperties && typeof s.additionalProperties === 'object')
        return `[String: ${swiftType(s.additionalProperties, hint + 'Value', indent, nested)}]`;
      if (!s.properties) return 'JSONValue';
      nested.push(...struct(hint, s, indent));
      return hint;
    default:
      return 'JSONValue';
  }
}

function singular(n: string) {
  return n.endsWith('ies') ? n.slice(0, -3) + 'y' : n.endsWith('s') ? n.slice(0, -1) : n + 'Element';
}

function doc(s: S, indent: string): string[] {
  return s.description ? s.description.split('\n').map((l: string) => `${indent}/// ${l}`) : [];
}

function struct(name: string, s: S, indent: string, discriminatorKey?: string, discriminatorValue?: string): string[] {
  const lines: string[] = [];
  const nested: string[] = [];
  const inner = indent + '    ';
  const required = new Set<string>(s.required ?? []);
  const props = Object.entries((s.properties ?? {}) as Record<string, S>);
  const fields = props.map(([key, ps]) => {
    const isDisc = key === discriminatorKey;
    let t = isDisc ? 'String' : swiftType(ps, pascal(key), inner, nested);
    const req = required.has(key);
    const nullable = t.endsWith('?');
    if (!req && !nullable) t += '?';
    if (t === 'JSONValue' && !req) t = 'JSONValue?';
    return { key, name: ident(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : camel(key)), type: t, req, isDisc, ps };
  });
  lines.push(...doc(s, indent));
  lines.push(`${indent}public struct ${name}: Codable, Sendable, Hashable {`);
  for (const f of fields) {
    lines.push(...doc(f.ps, inner));
    if (f.isDisc) lines.push(`${inner}public var ${f.name}: String = ${JSON.stringify(discriminatorValue)}`);
    else lines.push(`${inner}public var ${f.name}: ${f.type}`);
  }
  // memberwise init
  const params = fields
    .filter((f) => !f.isDisc)
    .map((f) => `${f.name}: ${f.type}${f.type.endsWith('?') ? ' = nil' : ''}`);
  lines.push('');
  lines.push(`${inner}public init(${params.join(', ')}) {`);
  for (const f of fields.filter((f) => !f.isDisc)) lines.push(`${inner}    self.${f.name} = ${f.name}`);
  lines.push(`${inner}}`);
  if (fields.length) {
    lines.push('');
    lines.push(`${inner}private enum CodingKeys: String, CodingKey {`);
    for (const f of fields) lines.push(`${inner}    case ${f.name} = ${JSON.stringify(f.key)}`);
    lines.push(`${inner}}`);
    lines.push('');
    lines.push(`${inner}public init(from decoder: any Decoder) throws {`);
    lines.push(`${inner}    let c = try decoder.container(keyedBy: CodingKeys.self)`);
    for (const f of fields) {
      const base = f.type.replace(/\?$/, '');
      if (f.type.endsWith('?')) lines.push(`${inner}    self.${f.name} = try c.decodeIfPresent(${base}.self, forKey: .${stripTicks(f.name)})`);
      else lines.push(`${inner}    self.${f.name} = try c.decode(${base}.self, forKey: .${stripTicks(f.name)})`);
    }
    lines.push(`${inner}}`);
    lines.push('');
    lines.push(`${inner}public func encode(to encoder: any Encoder) throws {`);
    lines.push(`${inner}    var c = encoder.container(keyedBy: CodingKeys.self)`);
    for (const f of fields) {
      if (f.req) lines.push(`${inner}    try c.encode(${f.name}, forKey: .${stripTicks(f.name)})`);
      else lines.push(`${inner}    try c.encodeIfPresent(${f.name}, forKey: .${stripTicks(f.name)})`);
    }
    lines.push(`${inner}}`);
  } else {
    lines.push(`${inner}public init(from decoder: any Decoder) throws {}`);
    lines.push(`${inner}public func encode(to encoder: any Encoder) throws { _ = encoder.container(keyedBy: AnyKey.self) }`);
  }
  if (nested.length) {
    lines.push('');
    lines.push(...nested);
  }
  lines.push(`${indent}}`);
  return lines;
}

const stripTicks = (n: string) => n.replace(/`/g, '');

function stringEnum(name: string, values: string[], indent: string): string[] {
  const inner = indent + '    ';
  const lines = [
    `${indent}public struct ${name}: RawRepresentable, Codable, Sendable, Hashable, CaseIterable, ExpressibleByStringLiteral {`,
    `${inner}public let rawValue: String`,
    `${inner}public init(rawValue: String) { self.rawValue = rawValue }`,
    `${inner}public init(stringLiteral value: String) { self.rawValue = value }`,
    `${inner}public init(from decoder: any Decoder) throws { self.rawValue = try decoder.singleValueContainer().decode(String.self) }`,
    `${inner}public func encode(to encoder: any Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }`,
  ];
  for (const v of values) lines.push(`${inner}public static let ${ident(camel(v))} = ${name}(rawValue: ${JSON.stringify(v)})`);
  lines.push(`${inner}public static let allCases: [${name}] = [${values.map((v) => '.' + ident(camel(v))).join(', ')}]`);
  lines.push(`${indent}}`);
  return lines;
}

function union(name: string, s: S, indent: string): string[] {
  const key = discriminator(s)!;
  const opts: S[] = s.oneOf ?? s.anyOf;
  const inner = indent + '    ';
  const lines: string[] = [];
  const cases = opts.map((o) => {
    const value = o.properties[key].const as string;
    return { value, caseName: ident(camel(value)), typeName: pascal(value), schema: o };
  });
  lines.push(...doc(s, indent));
  lines.push(`${indent}public enum ${name}: Codable, Sendable, Hashable {`);
  for (const c of cases) lines.push(`${inner}case ${c.caseName}(${c.typeName})`);
  lines.push(`${inner}/// A variant this client does not know yet (newer server).`);
  lines.push(`${inner}case unknown(JSONValue)`);
  lines.push('');
  lines.push(`${inner}public var ${ident(camel(key))}: String {`);
  lines.push(`${inner}    switch self {`);
  for (const c of cases) lines.push(`${inner}    case .${stripTicks(c.caseName)}: return ${JSON.stringify(c.value)}`);
  lines.push(`${inner}    case .unknown(let v): return v[${JSON.stringify(key)}]?.stringValue ?? ""`);
  lines.push(`${inner}    }`);
  lines.push(`${inner}}`);
  lines.push('');
  lines.push(`${inner}public init(from decoder: any Decoder) throws {`);
  lines.push(`${inner}    let c = try decoder.container(keyedBy: AnyKey.self)`);
  lines.push(`${inner}    let tag = try c.decodeIfPresent(String.self, forKey: AnyKey(${JSON.stringify(key)}))`);
  lines.push(`${inner}    switch tag {`);
  for (const c of cases) lines.push(`${inner}    case ${JSON.stringify(c.value)}: self = .${stripTicks(c.caseName)}(try ${c.typeName}(from: decoder))`);
  lines.push(`${inner}    default: self = .unknown(try JSONValue(from: decoder))`);
  lines.push(`${inner}    }`);
  lines.push(`${inner}}`);
  lines.push('');
  lines.push(`${inner}public func encode(to encoder: any Encoder) throws {`);
  lines.push(`${inner}    switch self {`);
  for (const c of cases) lines.push(`${inner}    case .${stripTicks(c.caseName)}(let v): try v.encode(to: encoder)`);
  lines.push(`${inner}    case .unknown(let v): try v.encode(to: encoder)`);
  lines.push(`${inner}    }`);
  lines.push(`${inner}}`);
  for (const c of cases) {
    lines.push('');
    lines.push(...struct(c.typeName, c.schema, inner, key, c.value));
  }
  lines.push(`${indent}}`);
  return lines;
}

function emitTop(name: string, s: S) {
  if (emitted.has(name)) return;
  emitted.add(name);
  const nested: string[] = [];
  const t = swiftType(s, name, '', nested);
  if (nested.length) out.push(...nested, '');
  else if (t !== name) out.push(`public typealias ${name} = ${t}`, '');
}

// ---- shared $defs ----
for (const [name, s] of Object.entries(defs)) {
  if (name === 'JsonValue') continue;
  emitTop(name, s);
}

// ---- methods ----
const methodDecls: string[] = [];
for (const [method, m] of Object.entries(schemaDoc.methods as Record<string, { params: S; result: S }>)) {
  const base = pascal(method);
  emitTop(`${base}Params`, m.params);
  emitTop(`${base}Result`, m.result);
  methodDecls.push(
    `    public enum ${base}: TetherMethod {`,
    `        public static let name = ${JSON.stringify(method)}`,
    `        public typealias Params = ${base}Params`,
    `        public typealias Result = ${base}Result`,
    `    }`,
  );
}
out.push('/// Client → server requests.', 'public enum Methods {', ...methodDecls, '}', '');

// ---- notifications ----
const notifCases: { method: string; caseName: string; type: string }[] = [];
for (const [method, s] of Object.entries(schemaDoc.notifications as Record<string, S>)) {
  const type = `${pascal(method)}Notification`;
  emitTop(type, s);
  notifCases.push({ method, caseName: ident(camel(method)), type });
}
out.push('/// Server → client notifications, decoded by method name.');
out.push('public enum ServerNotification: Sendable, Hashable {');
for (const c of notifCases) out.push(`    case ${c.caseName}(${c.type})`);
out.push('    case unknown(method: String, params: JSONValue)');
out.push('');
out.push('    public static let methods: Set<String> = [' + notifCases.map((c) => JSON.stringify(c.method)).join(', ') + ']');
out.push('');
out.push('    public init(method: String, params: Data, decoder: JSONDecoder = JSONDecoder()) throws {');
out.push('        switch method {');
for (const c of notifCases) out.push(`        case ${JSON.stringify(c.method)}: self = .${stripTicks(c.caseName)}(try decoder.decode(${c.type}.self, from: params))`);
out.push('        default: self = .unknown(method: method, params: try decoder.decode(JSONValue.self, from: params))');
out.push('        }');
out.push('    }');
out.push('');
out.push('    /// Thread this notification belongs to, and its per-thread sequence number.');
out.push('    public var threadId: String? {');
out.push('        switch self {');
for (const c of notifCases) out.push(`        case .${stripTicks(c.caseName)}(let n): return n.threadId`);
out.push('        case .unknown(_, let p): return p["threadId"]?.stringValue');
out.push('        }');
out.push('    }');
out.push('    public var seq: Int? {');
out.push('        switch self {');
for (const c of notifCases) out.push(`        case .${stripTicks(c.caseName)}(let n): return n.seq`);
out.push('        case .unknown(_, let p): return p["seq"]?.intValue');
out.push('        }');
out.push('    }');
out.push('}', '');

// ---- server requests ----
const reqCases: { method: string; caseName: string; base: string }[] = [];
for (const [method, m] of Object.entries(schemaDoc.serverRequests as Record<string, { params: S; result: S }>)) {
  const base = pascal(method);
  emitTop(`${base}Params`, m.params);
  emitTop(`${base}Response`, m.result);
  reqCases.push({ method, caseName: ident(camel(method)), base });
}
out.push('/// Server → client requests that the client must answer.');
out.push('public enum ServerRequest: Sendable, Hashable {');
for (const c of reqCases) out.push(`    case ${c.caseName}(${c.base}Params)`);
out.push('    case unknown(method: String, params: JSONValue)');
out.push('');
out.push('    public init(method: String, params: Data, decoder: JSONDecoder = JSONDecoder()) throws {');
out.push('        switch method {');
for (const c of reqCases) out.push(`        case ${JSON.stringify(c.method)}: self = .${stripTicks(c.caseName)}(try decoder.decode(${c.base}Params.self, from: params))`);
out.push('        default: self = .unknown(method: method, params: try decoder.decode(JSONValue.self, from: params))');
out.push('        }');
out.push('    }');
out.push('');
out.push('    public var requestId: String? {');
out.push('        switch self {');
for (const c of reqCases) out.push(`        case .${stripTicks(c.caseName)}(let p): return p.requestId`);
out.push('        case .unknown(_, let p): return p["requestId"]?.stringValue');
out.push('        }');
out.push('    }');
out.push('    public var threadId: String? {');
out.push('        switch self {');
for (const c of reqCases) out.push(`        case .${stripTicks(c.caseName)}(let p): return p.threadId`);
out.push('        case .unknown(_, let p): return p["threadId"]?.stringValue');
out.push('        }');
out.push('    }');
out.push('}', '');

const header = `// GENERATED by tether-server/scripts/gen-swift.ts from schema/tether.schema.json. Do not edit.
// swiftlint:disable all
import Foundation

public let tetherProtocolVersion = ${schemaDoc.protocolVersion}

`;
mkdirSync(outPath.split('/').slice(0, -1).join('/'), { recursive: true });
writeFileSync(outPath, header + out.join('\n'));
console.log(`wrote ${outPath} (${out.length} lines)`);
