export const meta = {
  name: 'ls-consensus',
  description: 'Three haiku agents run ls; a fourth verifies they agree',
  phases: [{ title: 'List', detail: '3 haiku agents run ls' }, { title: 'Verify', detail: 'haiku checks agreement' }],
}
const LS = {type: 'object', properties: {entries: {type: 'array', items: {type: 'string'}}}, required: ['entries']}
const VERDICT = {type: 'object', properties: {agree: {type: 'boolean'}, explanation: {type: 'string'}}, required: ['agree', 'explanation']}
phase('List')
const results = await parallel([0, 1, 2].map(i => () =>
  agent('Run `ls` in /home/me using Bash (no flags) and return the entry names exactly as printed.', {label: `ls-${i}`, phase: 'List', model: 'haiku', schema: LS})))
phase('Verify')
const verdict = await agent(
  'Three agents each ran `ls` in the same directory. Compare their outputs and decide whether they contain exactly the same set of entries. Outputs:\n' + JSON.stringify(results),
  {label: 'verify', phase: 'Verify', model: 'haiku', schema: VERDICT})
return {counts: results.map(r => r && r.entries.length), verdict}