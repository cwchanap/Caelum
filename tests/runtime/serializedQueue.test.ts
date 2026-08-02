import { describe, expect, it } from "vitest";
import { createSerializedQueue } from "../../src/runtime/serializedQueue";

describe("createSerializedQueue", () => {
  it("runs operations in enqueue order", async () => {
    const dead = false;
    const queue = createSerializedQueue(() => dead);
    const order: number[] = [];
    const first = queue.enqueue({
      operation: async () => {
        order.push(1);
        return 1;
      },
      whenDead: () => -1,
      onThrown: () => -2,
    });
    const second = queue.enqueue({
      operation: async () => {
        order.push(2);
        return 2;
      },
      whenDead: () => -1,
      onThrown: () => -2,
    });

    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual([1, 2]);
  });

  it("rechecks death when an operation reaches the head", async () => {
    let dead = false;
    const queue = createSerializedQueue(() => dead);
    let release!: () => void;
    const first = queue.enqueue({
      operation: () =>
        new Promise<number>((resolve) => {
          release = () => resolve(1);
        }),
      whenDead: () => -1,
      onThrown: () => -2,
    });
    let secondCalls = 0;
    const second = queue.enqueue({
      operation: async () => {
        secondCalls += 1;
        return 2;
      },
      whenDead: () => -1,
      onThrown: () => -2,
    });

    await Promise.resolve();
    dead = true;
    release();

    expect(await first).toBe(1);
    expect(await second).toBe(-1);
    expect(secondCalls).toBe(0);
  });

  it("recovers from a rejected operation and keeps serving subsequent ones", async () => {
    const queue = createSerializedQueue(() => false);
    const first = queue.enqueue({
      operation: async () => {
        throw new Error("boom");
      },
      whenDead: () => -1,
      onThrown: (error: unknown) =>
        error instanceof Error && error.message === "boom" ? -77 : -88,
    });
    const second = queue.enqueue({
      operation: async () => 2,
      whenDead: () => -1,
      onThrown: () => -2,
    });

    expect(await first).toBe(-77);
    expect(await second).toBe(2);
    await queue.drain();
  });
});
