/**
 * Where a new event stream for a thread starts numbering. A thread gets a new stream whenever its
 * query restarts (process exit, resume, rewind, daemon restart) or it is followed from disk.
 * Starting each above any earlier stream's numbers means a client still holding an older seq sees
 * a gap and reloads, instead of discarding the new stream's events as ones it already applied.
 * Microseconds since the epoch stay well inside a double's exact integers.
 */
export function seqOrigin(after = 0): number {
  // `after` is the last seq an earlier stream of the same thread used, in case the clock stepped back.
  return Math.max(Date.now() * 1000, after + 1);
}

/**
 * Whether a client that has seen events up to `afterSeq` can be caught up from a buffer holding
 * `oldest`…`latest`. A seq older than the buffer, or newer than anything this stream emitted
 * (it came from another stream), cannot.
 */
export function replayGap(afterSeq: number, oldest: number | undefined, latest: number): boolean {
  if (afterSeq === latest) return false;
  if (afterSeq > latest) return true;
  return afterSeq + 1 < (oldest ?? latest + 1);
}
