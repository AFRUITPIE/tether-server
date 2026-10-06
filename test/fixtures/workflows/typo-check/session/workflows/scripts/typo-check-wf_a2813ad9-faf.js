export const meta = {
  name: 'typo-check',
  description: 'List files, review each for typos/bugs, verify findings',
  phases: [{ title: 'Scan' }, { title: 'Review' }, { title: 'Verify' }],
}
const M = 'haiku'
phase('Scan')
const scan = await agent('List all regular files (non-recursive is fine unless subdirs exist; recurse otherwise, skip hidden/binary files) in /private/tmp/wf-scratch. Return absolute paths.', {
  model: M, phase: 'Scan', label: 'list-files',
  schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] },
})
const FIND = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, kind: { type: 'string' }, description: { type: 'string' } }, required: ['file', 'description'] } } }, required: ['findings'] }
phase('Review')
const reviews = await parallel((scan?.files || []).map(f => () => agent(`Read ${f} (do not edit). Find typos and code bugs. Return findings with line numbers; empty list if none.`, { model: M, phase: 'Review', label: `review:${f.split('/').pop()}`, schema: FIND })))
const all = reviews.filter(Boolean).flatMap(r => r.findings)
log(`${all.length} findings from ${scan?.files?.length ?? 0} files`)
phase('Verify')
let verified = []
if (all.length) {
  const V = { type: 'object', properties: { confirmed: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, description: { type: 'string' } }, required: ['file', 'description'] } } }, required: ['confirmed'] }
  const vs = await parallel([0, 1].map(i => () => agent(`Double-check these findings by reading the files (do not edit). Return only the real ones.\n${JSON.stringify(all)}`, { model: M, phase: 'Verify', label: `verify-${i + 1}`, schema: V })))
  verified = vs.filter(Boolean)
}
return { files: scan?.files, all, verified }