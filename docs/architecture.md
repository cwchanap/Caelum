# Architecture

Caelum is a browser-first TypeScript canvas game. Vite serves the app, the DOM hosts controls and panels, and canvas renderers draw the city map, overlays, transit lines, vehicles, and citizens.

The simulation modules are pure TypeScript and stay independent of the DOM and canvas. Game state, scenario data, map growth, citizen movement, transit vehicles, route planning, and objective evaluation can be exercised directly from tests without a browser.

The main runtime flow is:

1. UI events collect player intent from tools, map clicks, and controls.
2. Intent is validated into game actions before it changes state.
3. `tickSimulation` advances suburb growth, vehicles, citizens, and objectives.
4. Renderers draw the map, overlays, transit infrastructure, vehicles, and citizens from the latest state.
5. Panels display scenario metrics, objectives, tool state, and available actions.

The Growing Suburb scenario is deterministic for tests: initial state, growth thresholds, generated citizens, identifiers, and objective evaluation are stable across repeated runs.
