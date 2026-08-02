export function createSerializedQueue(isDead: () => boolean) {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(options: {
      operation: () => Promise<T>;
      whenDead: () => T;
      onThrown: (error: unknown) => T;
    }): Promise<T> {
      if (isDead()) return Promise.resolve(options.whenDead());

      const run = tail.then(async () => {
        if (isDead()) return options.whenDead();

        try {
          return await options.operation();
        } catch (error: unknown) {
          return options.onThrown(error);
        }
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
    drain(): Promise<void> {
      return tail;
    },
  };
}
