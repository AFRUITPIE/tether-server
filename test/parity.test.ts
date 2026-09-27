import { describe, expect, test } from 'bun:test';
import { Itemizer, userContentToInputs } from '../src/threads/itemizer.ts';

describe('documents', () => {
  test('a PDF in history is named, not carried', () => {
    const inputs = userContentToInputs([
      { type: 'text', text: 'Summarize this' },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' }, title: 'spec.pdf' },
    ]);
    expect(inputs).toEqual([
      { type: 'text', text: 'Summarize this' },
      { type: 'document', mediaType: 'application/pdf', name: 'spec.pdf' },
    ]);
  });
});

describe('messages from another session', () => {
  test('carry the sender name and session', () => {
    const iz = new Itemizer(() => 1, true);
    iz.ingest({
      type: 'user',
      uuid: 'peer-1',
      parent_tool_use_id: null,
      origin: { kind: 'peer', from: 'uds:/tmp/x.sock', name: 'Refactor auth', fromSession: 'local_1234' },
      message: { role: 'user', content: [{ type: 'text', text: 'I finished the auth refactor.' }] },
    });
    const item = iz.snapshot().items.find((i) => i.id === 'peer-1') as any;
    expect(item.origin).toBe('peer');
    expect(item.originName).toBe('Refactor auth');
    expect(item.originSession).toBe('local_1234');
  });
});
