import { describe, expect, test } from 'bun:test';
import { startingPermissionMode } from '../src/threads/ThreadManager.ts';

// The mode an interactive session starts in, as the CLI documents it: the settings' defaultMode,
// else auto where the model supports it, else default. The SDK's own start is always default.
describe('startingPermissionMode', () => {
  test("the host's defaultMode wins", () => {
    expect(startingPermissionMode({ permissions: { defaultMode: 'acceptEdits' } }, { supportsAutoMode: true })).toBe('acceptEdits');
    expect(startingPermissionMode({ permissions: { defaultMode: 'plan' } })).toBe('plan');
  });

  test('manual is the CLI alias for default', () => {
    expect(startingPermissionMode({ permissions: { defaultMode: 'manual' } }, { supportsAutoMode: true })).toBe('default');
  });

  test('with none set, auto where the model supports it', () => {
    expect(startingPermissionMode({}, { supportsAutoMode: true })).toBe('auto');
    expect(startingPermissionMode({}, { supportsAutoMode: false })).toBe('default');
    expect(startingPermissionMode({})).toBe('default');
  });

  test('disableAutoMode keeps it default', () => {
    expect(startingPermissionMode({ disableAutoMode: 'disable' }, { supportsAutoMode: true })).toBe('default');
  });

  test('an unknown mode falls through to the built-in start', () => {
    expect(startingPermissionMode({ permissions: { defaultMode: 'someday' } }, { supportsAutoMode: true })).toBe('auto');
  });
});
