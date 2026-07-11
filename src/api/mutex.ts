/** Minimal FIFO async mutex. `rebuildDerived` awaits candle fetches mid-flight, so two rebuilds
 * (a sync's and a journal edit's) could otherwise interleave and the slower one would overwrite the
 * fresher one's derived rows. Routing every rebuild through one mutex serializes those critical
 * sections. Single process ⇒ this is the whole concurrency primitive. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn); // run after the prior holder settles (success or failure)
    // Keep the queue alive regardless of this section's outcome — a rejection must not break the chain.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
