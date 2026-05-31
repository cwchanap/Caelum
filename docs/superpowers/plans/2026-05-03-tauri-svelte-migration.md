# Tauri + Svelte Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Caelum to a shared browser + Tauri desktop app with a Svelte shell while preserving the existing TypeScript simulation and canvas engine.

**Architecture:** Keep `src/simulation`, `src/domain`, and most of `src/render` host-agnostic. Introduce a `createGameRuntime` controller as the single owner of mutable game/UI state, then rebuild the current DOM shell as Svelte components that consume runtime selectors while the canvas remains imperative.

**Tech Stack:** Bun, TypeScript, Vite, Svelte, Tauri, HTML canvas, Vitest, Testing Library for Svelte, Playwright

---

## Source Spec

- Design spec: `docs/superpowers/specs/2026-05-03-tauri-svelte-migration-design.md`

## Scope Check

This spec is narrow enough for one implementation plan. It covers one migration track only: **shared TypeScript engine + Svelte shell + thin Tauri host**. Follow-up native features such as saves or menus should be separate specs and plans.

## Working Rules

- Execute this plan from a dedicated worktree before touching app code.
- Use @superpowers:subagent-driven-development unless the user explicitly prefers @superpowers:executing-plans.
- Keep the browser target working after every task.
- Do not move gameplay logic into Rust during this plan.
- Prefer deleting obsolete DOM-shell code over keeping duplicate UI paths once Svelte parity is reached.

## File Structure

### Create

- `svelte.config.js` - Svelte preprocess configuration for Vite and TypeScript.
- `src/App.svelte` - root Svelte shell that composes the HUD, control tower, and canvas host.
- `src/components/Topbar.svelte` - Svelte version of the current topbar metrics and pause/speed controls.
- `src/components/ControlTower.svelte` - Svelte version of the current tool palette, overlays, and scenario brief.
- `src/components/GameCanvas.svelte` - canvas host that binds the `<canvas>` element to the runtime and forwards pointer input.
- `src/runtime/createGameRuntime.ts` - single owner of `state`, `ui`, ticking, canvas bridging, and user intents.
- `src/runtime/runtimeSelectors.ts` - selectors that convert raw state into shell-friendly view data.
- `tests/runtime/gameRuntime.test.ts` - unit tests for runtime ticking, intents, and selectors.
- `tests/ui/appShell.test.ts` - jsdom component tests for `App.svelte`, `Topbar.svelte`, and `ControlTower.svelte`.
- `tests/ui/gameCanvas.test.ts` - jsdom tests for canvas mount/input forwarding.
- `src-tauri/Cargo.toml` - Rust crate manifest for the desktop host.
- `src-tauri/build.rs` - Tauri build script.
- `src-tauri/src/lib.rs` - thin desktop host library entry.
- `src-tauri/src/main.rs` - desktop app binary entry.
- `src-tauri/tauri.conf.json` - desktop window and bundling config.

### Modify

- `package.json` - add Svelte/Tauri/testing dependencies and desktop scripts.
- `tsconfig.json` - include `.svelte` files and keep strict TS checks green.
- `vite.config.ts` - add the Svelte plugin and preserve Vitest config.
- `src/main.ts` - stop building DOM manually and mount the Svelte app.
- `src/styles.css` - keep shell styling, but scoped around Svelte-owned markup instead of string-built DOM.
- `src/ui/panels.ts` - remove once no longer referenced by the runtime or browser entry.
- `tests/e2e/smoke.spec.ts` - keep browser smoke coverage aligned with the migrated shell.
- `README.md` - document browser + Tauri development commands.
- `docs/architecture.md` - document the runtime/controller and Svelte shell boundary.

### Keep Unchanged Unless Forced

- `src/simulation/**/*.ts`
- `src/domain/**/*.ts`
- `src/scenario/**/*.ts`
- `src/render/colors.ts`
- Most of `src/render/*.ts` other than call-site adjustments required by the runtime

## Task 1: Add Svelte and Tauri Host Scaffolding

**Files:**
- Create: `svelte.config.js`
- Create: `src/App.svelte`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/tauri.conf.json`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `vite.config.ts`
- Modify: `src/main.ts`
- Test: `tests/ui/appShell.test.ts`

- [ ] **Step 1: Write the failing shell bootstrap test**

Create `tests/ui/appShell.test.ts`:

```ts
// @vitest-environment jsdom
import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";

function createRuntimeStub() {
  return {
    getSnapshot: () => ({
      shell: {
        topbar: { budget: "$120,000", signalState: "Live" },
        controlTower: { title: "Growing Suburb", controlTowerOpen: true }
      }
    }),
    subscribe: vi.fn(() => () => {}),
    start: vi.fn(),
    stop: vi.fn()
  };
}

describe("App shell bootstrap", () => {
  it("renders the Svelte shell and canvas host", () => {
    render(App, { props: { runtime: createRuntimeStub() } });

    expect(screen.getByTestId("game-shell")).toBeVisible();
    expect(screen.getByTestId("game-canvas-host")).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the test to confirm the app has no Svelte shell yet**

Run: `bun run test tests/ui/appShell.test.ts`

Expected: FAIL with an import error for `../../src/App.svelte`, missing Svelte support, or both.

- [ ] **Step 3: Add Svelte/Tauri dependencies and config**

Update `package.json` to add the desktop and Svelte toolchain:

```json
{
  "scripts": {
    "dev": "vite --host 127.0.0.1",
    "build": "tsc --noEmit && svelte-check --tsconfig ./tsconfig.json && vite build",
    "check": "tsc --noEmit && svelte-check --tsconfig ./tsconfig.json",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.0.0",
    "svelte": "^5.0.0",
    "vite": "^7.0.0"
  },
  "devDependencies": {
    "@sveltejs/vite-plugin-svelte": "^4.0.0",
    "@tauri-apps/cli": "^2.0.0",
    "@testing-library/svelte": "^5.0.0",
    "jsdom": "^26.0.0",
    "svelte-check": "^4.0.0",
    "typescript": "^5.8.0",
    "vitest": "^3.2.0"
  }
}
```

Create `svelte.config.js`:

```js
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess()
};
```

Update `vite.config.ts`:

```ts
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: "127.0.0.1",
    port: 5173
  },
  test: {
    environment: "node",
    globals: true,
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"]
  }
});
```

Update `tsconfig.json` includes:

```json
{
  "include": ["src", "tests", "vite.config.ts", "playwright.config.ts", "svelte.config.js"]
}
```

- [ ] **Step 4: Mount a minimal Svelte shell and scaffold Tauri**

Create `src/App.svelte`:

```svelte
<script lang="ts">
  export let error: string | null = null;
  export let runtime: {
    getSnapshot: () => { shell: unknown };
    subscribe: (listener: (snapshot: unknown) => void) => () => void;
    start: () => void;
    stop: () => void;
  };
</script>

{#if error}
  <main class="shell shell--error" data-testid="game-shell">
    <div class="shell-error" role="alert">{error}</div>
  </main>
{:else}
  <main class="shell" data-testid="game-shell">
    <section class="topbar">Caelum</section>
    <section class="board-region" data-testid="game-canvas-host"></section>
    <aside class="panel">Loading Control Tower…</aside>
  </main>
{/if}
```

Replace `src/main.ts` with Svelte mounting:

```ts
import "./styles.css";
import { mount } from "svelte";
import App from "./App.svelte";

const app = document.querySelector<HTMLDivElement>("#app");

if (app === null) {
  throw new Error("Missing #app root");
}

try {
  mount(App, {
    target: app,
    props: {
      error: null,
      runtime: {
        getSnapshot: () => ({ shell: {} }),
        subscribe: () => () => {},
        start: () => undefined,
        stop: () => undefined
      }
    }
  });
} catch (error) {
  mount(App, {
    target: app,
    props: {
      error: error instanceof Error ? error.message : "Failed to start Caelum.",
      runtime: {
        getSnapshot: () => ({ shell: {} }),
        subscribe: () => () => {},
        start: () => undefined,
        stop: () => undefined
      }
    }
  });
}
```

Create the Tauri host with the standard CLI scaffold:

```bash
bunx tauri init --ci --app-name Caelum --window-title Caelum --frontend-dist ../dist --dev-url http://127.0.0.1:5173
```

Expected: creates `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/src/main.rs`, and `src-tauri/tauri.conf.json`. If the scaffold generates `src-tauri/src/lib.rs`, keep it thin and host-only.

- [ ] **Step 5: Run the bootstrap checks**

Run: `bun install && bun run check && bun run test tests/ui/appShell.test.ts && bun run build`

Expected: PASS. The browser build succeeds, the new shell test passes, and `dist/` is produced.

- [ ] **Step 6: Commit the host scaffold**

Run:

```bash
git add package.json bun.lock tsconfig.json vite.config.ts svelte.config.js src/main.ts src/App.svelte src-tauri tests/ui/appShell.test.ts
git commit -m "feat: scaffold svelte and tauri hosts"
```

## Task 2: Extract a Testable Game Runtime Controller

**Files:**
- Create: `src/runtime/createGameRuntime.ts`
- Create: `src/runtime/runtimeSelectors.ts`
- Test: `tests/runtime/gameRuntime.test.ts`
- Modify: `src/main.ts`
- Modify: `src/App.svelte`

- [ ] **Step 1: Write the failing runtime test**

Create `tests/runtime/gameRuntime.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";

describe("game runtime", () => {
  it("owns game and UI state in one place", () => {
    const runtime = createGameRuntime();

    runtime.setTool("busStop");
    runtime.togglePause();
    runtime.tick(1);

    const snapshot = runtime.getSnapshot();
    expect(snapshot.ui.activeTool).toBe("busStop");
    expect(snapshot.state.paused).toBe(false);
  });

  it("publishes shell-friendly selectors", () => {
    const runtime = createGameRuntime();
    const shell = runtime.getSnapshot().shell;

    expect(shell.topbar.budget).toBe("$120,000");
    expect(shell.controlTower.title).toBe("Growing Suburb");
  });
});
```

- [ ] **Step 2: Run the test to prove the runtime does not exist yet**

Run: `bun run test tests/runtime/gameRuntime.test.ts`

Expected: FAIL with `Cannot find module '../../src/runtime/createGameRuntime'`.

- [ ] **Step 3: Implement the runtime and selectors**

Create `src/runtime/runtimeSelectors.ts`:

```ts
import type { GameState } from "../domain/types";
import type { UiState } from "../ui/uiState";

export function createShellSnapshot(state: GameState, ui: UiState) {
  return {
    topbar: {
      budget: `$${state.budget.toLocaleString()}`,
      signalState: state.paused ? "Hold" : "Live",
      time: state.time,
      population: state.citizens.length,
      lateTrips: state.metrics.lateTrips,
      unservedTrips: state.metrics.unservedTrips,
      averageWaitSeconds: Math.floor(state.metrics.averageWaitSeconds),
      speed: state.paused ? 0 : state.speed
    },
    controlTower: {
      title: state.scenario.name,
      controlTowerOpen: ui.controlTowerOpen,
      activeTool: ui.activeTool,
      activeOverlay: ui.activeOverlay,
      status: state.metrics.state.toUpperCase(),
      objective: `Hold late trips below ${Math.round(state.scenario.objectives.maxLateRatio * 100)}%, unserved below ${Math.round(
        state.scenario.objectives.maxUnservedRatio * 100
      )}%, average wait under ${state.scenario.objectives.maxAverageWait}s.`,
      lossNote: state.metrics.lossReason ?? "Within tolerances. Hold the line.",
      nextGrowth: state.scenario.growthWaves.find((wave) => !wave.applied)?.message ?? "All growth waves resolved.",
      selected: ui.selectedId ?? "—"
    }
  };
}
```

Create `src/runtime/createGameRuntime.ts` around existing helpers:

```ts
import { canvasToTile, renderGame, syncCanvasSize } from "../render/canvas";
import { createInitialGameState } from "../simulation/gameState";
import { tickSimulation } from "../simulation/simulation";
import { handleTileClick as handleGameTileClick } from "../ui/actions";
import { createUiState } from "../ui/uiState";
import { createShellSnapshot } from "./runtimeSelectors";

export function createGameRuntime() {
  let state = createInitialGameState();
  let ui = createUiState();
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let frameId: number | null = null;
  const listeners = new Set<(snapshot: ReturnType<typeof getSnapshot>) => void>();

  function getSnapshot() {
    return {
      state,
      ui,
      shell: createShellSnapshot(state, ui)
    };
  }

  function publish() {
    const snapshot = getSnapshot();
    listeners.forEach((listener) => listener(snapshot));

    if (canvas !== null && context !== null) {
      syncCanvasSize(canvas);
      renderGame(context, state, ui);
    }
  }

  function stopLoop() {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
  }

  function startLoop() {
    if (frameId !== null || canvas === null) return;

    let lastFrame = performance.now();
    const frame = (now: number) => {
      const deltaSeconds = Math.min(0.25, (now - lastFrame) / 1000);
      lastFrame = now;
      state = tickSimulation(state, deltaSeconds);
      publish();
      frameId = requestAnimationFrame(frame);
    };

    frameId = requestAnimationFrame(frame);
  }

  return {
    getSnapshot,
    subscribe(listener: (snapshot: ReturnType<typeof getSnapshot>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tick(deltaSeconds: number) {
      state = tickSimulation(state, deltaSeconds);
      publish();
    },
    setTool(tool: typeof ui.activeTool) {
      ui = { ...ui, activeTool: tool, draftStopIds: [], draftStationIds: [] };
      publish();
    },
    toggleControlTower() {
      ui = { ...ui, controlTowerOpen: !ui.controlTowerOpen };
      publish();
    },
    toggleOverlay(overlay: typeof ui.activeOverlay) {
      ui = { ...ui, activeOverlay: ui.activeOverlay === overlay ? null : overlay };
      publish();
    },
    togglePause() {
      state = { ...state, paused: !state.paused };
      publish();
    },
    setSpeed(speed: typeof state.speed) {
      state = { ...state, speed, paused: false };
      publish();
    },
    resetUi() {
      ui = createUiState();
      publish();
    },
    start() {
      startLoop();
    },
    stop() {
      stopLoop();
    },
    attachCanvas(nextCanvas: HTMLCanvasElement) {
      const nextContext = nextCanvas.getContext("2d");
      if (nextContext === null) throw new Error("Canvas is unavailable");

      canvas = nextCanvas;
      context = nextContext;
      publish();

      return () => {
        canvas = null;
        context = null;
        stopLoop();
      };
    },
    handlePointerMove(clientX: number, clientY: number) {
      if (canvas === null) return;
      ui = { ...ui, hoverTile: canvasToTile(canvas, clientX, clientY, state.map) };
      publish();
    },
    handleCanvasClick(clientX: number, clientY: number) {
      if (canvas === null) return;
      const point = canvasToTile(canvas, clientX, clientY, state.map);
      if (point === null) return;

      const result = handleGameTileClick(state, ui, point);
      state = result.state;
      ui = result.ui;
      publish();
    }
  };
}
```

Expose the real runtime from `src/main.ts` and pass it into `App.svelte`. The public API must already include `subscribe`, `start`, `stop`, `setTool`, `toggleControlTower`, `toggleOverlay`, `togglePause`, `setSpeed`, `resetUi`, `attachCanvas`, `handlePointerMove`, and `handleCanvasClick` so later tasks can stay additive instead of reshaping the interface again.

- [ ] **Step 4: Run runtime and regression checks**

Run: `bun run test tests/runtime/gameRuntime.test.ts tests/ui/actions.test.ts tests/render/canvas.test.ts`

Expected: PASS. The runtime tests pass without breaking existing action or render contracts.

- [ ] **Step 5: Commit the runtime boundary**

Run:

```bash
git add src/runtime src/main.ts src/App.svelte tests/runtime/gameRuntime.test.ts
git commit -m "refactor: add shared game runtime"
```

## Task 3: Replace the Topbar and Control Tower with Svelte Components

**Files:**
- Create: `src/components/Topbar.svelte`
- Create: `src/components/ControlTower.svelte`
- Modify: `src/App.svelte`
- Modify: `src/styles.css`
- Test: `tests/ui/appShell.test.ts`

- [ ] **Step 1: Expand the shell test to describe the real migrated UI**

Update `tests/ui/appShell.test.ts`:

```ts
// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";

function createRuntimeStub() {
  return {
    getSnapshot: () => ({
      shell: {
        topbar: {
          budget: "$120,000",
          signalState: "Live",
          time: 0,
          population: 36,
          lateTrips: 0,
          unservedTrips: 0,
          averageWaitSeconds: 0,
          speed: 1
        },
        controlTower: {
          title: "Growing Suburb",
          controlTowerOpen: true,
          activeTool: "inspect",
          activeOverlay: null,
          objective: "Hold late trips below 35%, unserved below 20%, average wait under 90s.",
          status: "Stable",
          lossNote: "Within tolerances. Hold the line.",
          nextGrowth: "Wave 2 at T+03:00",
          selected: "—"
        }
      }
    }),
    subscribe: vi.fn(() => () => {}),
    start: vi.fn(),
    stop: vi.fn(),
    setTool: vi.fn(),
    toggleControlTower: vi.fn(),
    toggleOverlay: vi.fn(),
    togglePause: vi.fn(),
    setSpeed: vi.fn(),
    resetUi: vi.fn()
  };
}

describe("App shell", () => {
  it("renders the topbar and control tower from runtime selectors", async () => {
    const runtime = createRuntimeStub();
    render(App, { props: { runtime } });

    expect(screen.getByText("Growing Suburb")).toBeVisible();
    expect(screen.getByText("$120,000")).toBeVisible();
    expect(screen.getByText("36")).toBeVisible();
    expect(screen.getByText(/Hold late trips below/)).toBeVisible();

    await fireEvent.click(screen.getByRole("button", { name: "Bus Stop" }));
    expect(runtime.setTool).toHaveBeenCalledWith("busStop");
  });
});
```

- [ ] **Step 2: Run the component test and capture the missing Svelte pieces**

Run: `bun run test tests/ui/appShell.test.ts`

Expected: FAIL because `Topbar.svelte`, `ControlTower.svelte`, or matching controls do not exist yet.

- [ ] **Step 3: Implement `Topbar.svelte`, `ControlTower.svelte`, and compose them in `App.svelte`**

Create `src/components/Topbar.svelte`:

```svelte
<script lang="ts">
  export let topbar: {
    budget: string;
    signalState: string;
    time: number;
    population: number;
    lateTrips: number;
    unservedTrips: number;
    averageWaitSeconds: number;
    speed: 0 | 1 | 2 | 4;
  };
  export let onTogglePause: () => void;
  export let onToggleControlTower: () => void;
  export let onSetSpeed: (speed: 1 | 2 | 4) => void;
</script>

<section class="topbar" data-testid="topbar">
  <span>{topbar.budget}</span>
  <span>{topbar.signalState}</span>
  <span>{topbar.time}</span>
  <span>{topbar.population}</span>
  <span>{topbar.lateTrips}</span>
  <span>{topbar.unservedTrips}</span>
  <span>{topbar.averageWaitSeconds}s</span>
  <button on:click={onToggleControlTower}>Control Tower</button>
  <button on:click={onTogglePause}>Pause</button>
  <button aria-pressed={topbar.speed === 1} on:click={() => onSetSpeed(1)}>1x</button>
  <button aria-pressed={topbar.speed === 2} on:click={() => onSetSpeed(2)}>2x</button>
  <button aria-pressed={topbar.speed === 4} on:click={() => onSetSpeed(4)}>4x</button>
</section>
```

Create `src/components/ControlTower.svelte` with:

- a visibility toggle bound to `runtime.toggleControlTower()`
- scenario brief readouts for `title`, `objective`, `status`, `lossNote`, and `nextGrowth`
- selection details for `selected`
- tool buttons using exact IDs:
  - `Inspect` -> `"inspect"`
  - `Bus Stop` -> `"busStop"`
  - `Bus Route` -> `"busRoute"`
  - `Metro Station` -> `"metroStation"`
  - `Metro Line` -> `"metroLine"`
  - `Civic` -> `"civicAnchor"`
  - `Remove` -> `"remove"`
- overlay buttons using exact IDs:
  - `Coverage` -> `"coverage"`
  - `Crowding` -> `"crowding"`
  - `Demand` -> `"demand"`
  - `Lateness` -> `"lateness"`
  - `Growth` -> `"growth"`
- an Escape/reset path bound to `runtime.resetUi()`

Wire those controls to `runtime.setTool(...)`, `runtime.toggleOverlay(...)`, `runtime.toggleControlTower()`, and `runtime.resetUi()`.

Update `src/App.svelte` to:

```svelte
<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import ControlTower from "./components/ControlTower.svelte";
  import Topbar from "./components/Topbar.svelte";
  import { createGameRuntime } from "./runtime/createGameRuntime";

  export let error: string | null = null;
  export let runtime = createGameRuntime();

  let snapshot = runtime.getSnapshot();

  const unsubscribe = runtime.subscribe((next) => {
    snapshot = next;
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      runtime.resetUi();
    }
  };

  onMount(() => {
    runtime.start();
    window.addEventListener("keydown", onKeyDown);
  });
  onDestroy(() => {
    unsubscribe();
    runtime.stop();
    window.removeEventListener("keydown", onKeyDown);
  });
</script>

{#if error}
  <main class="shell shell--error" data-testid="game-shell">
    <div class="shell-error" role="alert">{error}</div>
  </main>
{:else}
  <main class="shell" data-testid="game-shell">
    <Topbar
      topbar={snapshot.shell.topbar}
      onTogglePause={() => runtime.togglePause()}
      onToggleControlTower={() => runtime.toggleControlTower()}
      onSetSpeed={(speed) => runtime.setSpeed(speed)}
    />
    <section class="board-region" data-testid="game-canvas-host"></section>
    <ControlTower
      controlTower={snapshot.shell.controlTower}
      onSetTool={(tool) => runtime.setTool(tool)}
      onToggleOverlay={(overlay) => runtime.toggleOverlay(overlay)}
      onToggleControlTower={() => runtime.toggleControlTower()}
      onResetUi={() => runtime.resetUi()}
    />
  </main>
{/if}
```

- [ ] **Step 4: Run shell tests and core regressions**

Run: `bun run test tests/ui/appShell.test.ts tests/ui/actions.test.ts tests/simulation/router.test.ts`

Expected: PASS. The Svelte shell renders, dispatches intents, and existing engine behavior remains unchanged.

- [ ] **Step 5: Commit the Svelte shell migration**

Run:

```bash
git add src/App.svelte src/components/Topbar.svelte src/components/ControlTower.svelte src/styles.css tests/ui/appShell.test.ts
git commit -m "feat: migrate shell chrome to svelte"
```

## Task 4: Bind the Imperative Canvas to the Runtime Through a Svelte Host

**Files:**
- Create: `src/components/GameCanvas.svelte`
- Test: `tests/ui/gameCanvas.test.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/render/canvas.ts` (only if the runtime needs a cleaner canvas attachment seam)
- Modify: `src/App.svelte`

- [ ] **Step 1: Write the failing canvas host test**

Create `tests/ui/gameCanvas.test.ts`:

```ts
// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import GameCanvas from "../../src/components/GameCanvas.svelte";

describe("GameCanvas", () => {
  it("registers the canvas with the runtime and forwards pointer events", async () => {
    const runtime = {
      attachCanvas: vi.fn(() => () => {}),
      handlePointerMove: vi.fn(),
      handleCanvasClick: vi.fn()
    };

    render(GameCanvas, { props: { runtime, onShellError: vi.fn() } });
    const canvas = screen.getByTestId("game-canvas");

    expect(runtime.attachCanvas).toHaveBeenCalled();

    await fireEvent.mouseMove(canvas, { clientX: 100, clientY: 120 });
    await fireEvent.click(canvas, { clientX: 100, clientY: 120 });

    expect(runtime.handlePointerMove).toHaveBeenCalledWith(100, 120);
    expect(runtime.handleCanvasClick).toHaveBeenCalledWith(100, 120);
  });
});
```

- [ ] **Step 2: Run the test to show the canvas host API is missing**

Run: `bun run test tests/ui/gameCanvas.test.ts`

Expected: FAIL because `GameCanvas.svelte` and/or `runtime.attachCanvas` do not exist yet.

- [ ] **Step 3: Implement the canvas host and runtime attachment**

Create `src/components/GameCanvas.svelte`:

```svelte
<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  export let runtime: {
    attachCanvas: (canvas: HTMLCanvasElement) => () => void;
    handlePointerMove: (clientX: number, clientY: number) => void;
    handleCanvasClick: (clientX: number, clientY: number) => void;
  };
  export let onShellError: (message: string) => void;

  let canvas: HTMLCanvasElement;
  let detachCanvas = () => undefined;

  onMount(() => {
    try {
      detachCanvas = runtime.attachCanvas(canvas);
    } catch (error) {
      onShellError(error instanceof Error ? error.message : "Failed to attach game canvas.");
    }
  });

  onDestroy(() => detachCanvas());
</script>

<section class="board-region" data-testid="game-canvas-host">
  <canvas
    bind:this={canvas}
    class="board"
    data-testid="game-canvas"
    width="1280"
    height="800"
    on:mousemove={(event) => runtime.handlePointerMove(event.clientX, event.clientY)}
    on:click={(event) => runtime.handleCanvasClick(event.clientX, event.clientY)}
  />
</section>
```

Update `src/App.svelte` to replace the placeholder board region with `<GameCanvas runtime={runtime} onShellError={(message) => (error = message)} />`.

The runtime API already exists from Task 2. In this task, wire the canvas-specific methods instead of changing the overall runtime shape again. The attachment should register the real canvas/context, and `start()` / `stop()` should remain the only methods that create or cancel the animation loop.

Extend `createGameRuntime()` with:

```ts
attachCanvas(nextCanvas: HTMLCanvasElement) {
  const ctx = nextCanvas.getContext("2d");
  if (ctx === null) throw new Error("Canvas is unavailable");

  canvas = nextCanvas;
  context = ctx;
  syncCanvasSize(nextCanvas);
  renderGame(ctx, state, ui);

  return () => {
    canvas = null;
    context = null;
    stopLoop();
  };
}
```

Keep the canvas renderer imperative. Do not move drawing into Svelte.

- [ ] **Step 4: Run the canvas-focused tests**

Run: `bun run test tests/ui/gameCanvas.test.ts tests/render/canvas.test.ts tests/runtime/gameRuntime.test.ts`

Expected: PASS. Canvas sizing and runtime forwarding stay intact.

- [ ] **Step 5: Commit the canvas host**

Run:

```bash
git add src/App.svelte src/components/GameCanvas.svelte src/runtime/createGameRuntime.ts src/render/canvas.ts tests/ui/gameCanvas.test.ts tests/render/canvas.test.ts
git commit -m "feat: host canvas through svelte runtime"
```

## Task 5: Remove the Imperative DOM Shell and Re-Establish Browser + Desktop Parity

**Files:**
- Modify: `src/main.ts`
- Delete: `src/ui/panels.ts`
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `src/styles.css`

- [ ] **Step 1: Rewrite the browser smoke test around the new shell**

Update `tests/e2e/smoke.spec.ts` to prove the migrated browser path still works:

```ts
import { expect, test } from "@playwright/test";

test("loads the svelte shell and supports a basic bus-stop placement", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("game-shell")).toBeVisible();
  await expect(page.getByTestId("topbar")).toBeVisible();
  await expect(page.getByTestId("game-canvas")).toBeVisible();
  await expect(page.getByText("Growing Suburb")).toBeVisible();

  await page.getByRole("button", { name: "Bus Stop" }).click();
  await page.getByTestId("game-canvas").click({ position: { x: 320, y: 320 } });

  await expect(page.getByText("$118,000")).toBeVisible();
});
```

- [ ] **Step 2: Run the smoke test and capture remaining parity gaps**

Run: `bun run test:e2e -- --grep "loads the svelte shell"`

Expected: FAIL until the old panel rendering path is fully removed and the Svelte shell exposes the expected controls.

- [ ] **Step 3: Delete the old shell path and update docs**

Make these changes:

- Replace `src/main.ts` with a pure Svelte mount only.
- Delete `src/ui/panels.ts` once imports are gone.
- Update `README.md` run section to:

````md
## Run

```sh
bun install
bun run dev
bun run tauri:dev
```
````

- Update `docs/architecture.md` to describe:
  - `createGameRuntime()` as the single state owner
  - Svelte-owned shell components
  - imperative canvas rendering through `GameCanvas.svelte`
  - browser + Tauri hosts sharing the same frontend

- [ ] **Step 4: Run the automated verification set**

Run: `bun run check && bun run test && bun run test:e2e && bun run build && bun run tauri:build -- --debug`

Expected: PASS. Browser tests stay green, the web build succeeds, and the Tauri debug build completes for macOS.

- [ ] **Step 5: Run the macOS desktop smoke check**

Run: `bun run tauri:dev`

Expected: the Caelum desktop window opens on macOS, shows the Svelte shell, renders the canvas, and responds to one basic control interaction before you close it manually.

- [ ] **Step 6: Commit the parity pass**

Run:

```bash
git add src/main.ts src/styles.css src/ui/panels.ts tests/e2e/smoke.spec.ts README.md docs/architecture.md
git commit -m "refactor: complete tauri svelte migration shell"
```

## Final Verification Checklist

- [ ] Browser app still starts with `bun run dev`
- [ ] Svelte shell owns topbar/control tower rendering
- [ ] Canvas rendering still uses existing TypeScript renderers
- [ ] Runtime is the single owner of mutable state
- [ ] Browser smoke test covers a basic gameplay interaction
- [ ] macOS desktop app boots and shows the shared frontend
- [ ] Tauri debug build succeeds on macOS
- [ ] `README.md` and `docs/architecture.md` match the new structure

## Execution Notes

- Implement in task order. Do not skip ahead to Tauri polish before runtime and shell parity are done.
- Keep commits small and task-scoped.
- If Tauri scaffolding creates extra generated files (for example icons), commit them only if required by `tauri build`.
- If a task reveals that `src/ui/panels.ts` still contains reusable formatting helpers, move those helpers into a shared non-DOM utility file instead of keeping the old renderer alive.
