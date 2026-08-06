import { describe, expect, it } from "vitest";
import {
  createCityPersistenceQueues,
  createSharedPersistenceCoordinator,
  PersistenceLeaseClosedError,
} from "../../src/runtime/persistenceCoordinator";

describe("shared coordinator ownership model", () => {
  it("a former lease cannot enqueue after closing and release", async () => {
    const coordinator = createSharedPersistenceCoordinator();
    const lease1 = await coordinator.acquireLease();
    lease1.beginClosing();
    await lease1.drainAll();
    lease1.release();

    const lease2 = await coordinator.acquireLease();
    expect(lease1.isClosed).toBe(true);
    expect(lease2.isClosed).toBe(false);

    // Attempting to enqueue through the former (closed) lease must reject
    // and must never invoke the work callback.
    let workCalled = false;
    await expect(
      lease1.enqueue("city-X", async () => {
        workCalled = true;
        return 42;
      }),
    ).rejects.toThrow(PersistenceLeaseClosedError);
    expect(workCalled).toBe(false);

    // Acquiring a fence through the former lease must also throw.
    expect(() => lease1.acquireCityFence("city-X")).toThrow(
      PersistenceLeaseClosedError,
    );

    // The active lease can still enqueue normally.
    const result = await lease2.enqueue("city-Y", async () => "ok");
    expect(result).toBe("ok");
    lease2.beginClosing();
    await lease2.drainAll();
    lease2.release();
  });

  it("a queued lease handoff creates a fresh open capability", async () => {
    // Regression: `release()` previously passed the closed predecessor
    // lease to the queued waiter. The waiter then received an unusable
    // capability whose `enqueue` rejected and `acquireCityFence` threw,
    // while `createGameRuntime` had already resolved successfully.
    const coordinator = createSharedPersistenceCoordinator();
    const lease1 = await coordinator.acquireLease();

    // Queue runtime 2 BEFORE runtime 1 releases. This exercises the
    // queued-handoff branch in `release()`, not the empty-holder branch
    // that `acquireLease()` takes when no holder is set.
    const lease2Promise = coordinator.acquireLease();

    lease1.beginClosing();
    await lease1.drainAll();
    lease1.release();

    const lease2 = await lease2Promise;

    // The new owner must receive a distinct, OPEN capability — not the
    // closed lease being released.
    expect(lease2).not.toBe(lease1);
    expect(lease2.isClosed).toBe(false);

    // The fresh lease must be fully usable: enqueue runs work and
    // resolves with the typed value, and fence acquisition succeeds.
    await expect(lease2.enqueue("city-B", async () => "ok")).resolves.toBe(
      "ok",
    );
    expect(() => lease2.acquireCityFence("city-B")).not.toThrow();
    lease2.releaseCityFence("city-B");

    lease2.beginClosing();
    await lease2.drainAll();
    lease2.release();
  });

  it("releaseCityFence decrements the refcount and keeps the fence until the last release", async () => {
    const coordinator = createSharedPersistenceCoordinator();
    const lease = await coordinator.acquireLease();
    // Acquire the same fence twice to exercise the refcount > 1 path.
    lease.acquireCityFence("city-ref");
    lease.acquireCityFence("city-ref");
    expect(lease.isCityFenced("city-ref")).toBe(true);
    // First release decrements but the fence remains.
    lease.releaseCityFence("city-ref");
    expect(lease.isCityFenced("city-ref")).toBe(true);
    // Second release drops the refcount to zero and removes the fence.
    lease.releaseCityFence("city-ref");
    expect(lease.isCityFenced("city-ref")).toBe(false);
    lease.beginClosing();
    await lease.drainAll();
    lease.release();
  });

  it("admitForeground returns false once the lease is closing", async () => {
    const coordinator = createSharedPersistenceCoordinator();
    const lease = await coordinator.acquireLease();
    expect(lease.admitForeground()).toBe(true);
    lease.releaseForeground();
    lease.beginClosing();
    expect(lease.admitForeground()).toBe(false);
    await lease.drainAll();
    lease.release();
  });

  it("drainAll stays pending while outstanding foreground work is in flight and resolves once released", async () => {
    const coordinator = createSharedPersistenceCoordinator();
    const lease = await coordinator.acquireLease();
    expect(lease.admitForeground()).toBe(true);

    const drained = lease.drainAll();
    let resolved = false;
    drained.then(() => {
      resolved = true;
    });

    // Yield microtasks: drainAll must not have resolved while the foreground
    // operation is still outstanding.
    await Promise.resolve();
    expect(resolved).toBe(false);

    lease.releaseForeground();
    await expect(drained).resolves.toBeUndefined();
    expect(resolved).toBe(true);

    lease.beginClosing();
    await lease.drainAll();
    lease.release();
  });
});

describe("createCityPersistenceQueues", () => {
  it("serializes work per city and cleans up the tail after completion", async () => {
    const queues = createCityPersistenceQueues();
    const order: string[] = [];
    const first = queues.enqueue("city-a", async () => {
      order.push("first");
    });
    const second = queues.enqueue("city-a", async () => {
      order.push("second");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    await expect(queues.drain("city-a")).resolves.toBeUndefined();
  });

  it("runs work for different cities concurrently", async () => {
    const queues = createCityPersistenceQueues();
    let aDone = false;
    let bDone = false;
    const a = queues.enqueue("city-a", async () => {
      await Promise.resolve();
      aDone = true;
    });
    const b = queues.enqueue("city-b", async () => {
      bDone = true;
    });
    await b;
    expect(bDone).toBe(true);
    await a;
    expect(aDone).toBe(true);
  });

  it("drain resolves immediately for a city with no pending work", async () => {
    const queues = createCityPersistenceQueues();
    await expect(queues.drain("city-none")).resolves.toBeUndefined();
  });

  it("runs the next work even when the previous work rejects", async () => {
    const queues = createCityPersistenceQueues();
    const first = queues.enqueue("city-a", async () => {
      throw new Error("boom");
    });
    await expect(first).rejects.toThrow("boom");
    let secondRan = false;
    await queues.enqueue("city-a", async () => {
      secondRan = true;
    });
    expect(secondRan).toBe(true);
  });
});
