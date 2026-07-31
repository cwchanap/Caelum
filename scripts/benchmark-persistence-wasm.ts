import { createWasmBackend } from "../src/runtime/backend/wasmBackend";
import validPaused from "../tests/fixtures/persistence/valid-paused.json";

const WARMUP_COUNT = 2;
const SAMPLE_COUNT = 25;

type OperationResult = { ok: true } | { ok: false; error: unknown };

function percentile(sorted: readonly number[], value: number): number {
  const rank = Math.ceil((sorted.length * value) / 100);
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)];
}

async function requireSuccess(
  label: string,
  operation: () => Promise<OperationResult>,
): Promise<void> {
  const result = await operation();
  if (!result.ok) {
    throw new Error(`${label} failed: ${JSON.stringify(result.error)}`);
  }
}

async function measure(
  label: string,
  operation: () => Promise<OperationResult>,
): Promise<void> {
  const coldStarted = performance.now();
  await requireSuccess(label, operation);
  const cold = performance.now() - coldStarted;

  for (let index = 0; index < WARMUP_COUNT; index += 1) {
    await requireSuccess(label, operation);
  }

  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const started = performance.now();
    await requireSuccess(label, operation);
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);

  const median = samples[Math.floor(samples.length / 2)];
  const p95 = percentile(samples, 95);
  console.log(
    `${label}: cold=${cold.toFixed(3)}ms, median=${median.toFixed(3)}ms, ` +
      `p95=${p95.toFixed(3)}ms, samples=${SAMPLE_COUNT}`,
  );
}

const validationBackend = await createWasmBackend();
await measure("validateSnapshot", () =>
  validationBackend.validateSnapshot({ snapshot: validPaused }),
);

const restoreBackend = await createWasmBackend();
await measure("restoreSnapshot", () =>
  restoreBackend.restoreSnapshot({ snapshot: validPaused }),
);
