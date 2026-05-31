import type { CitizenStatus, GameState } from "../domain/types";
import { tileSize } from "./canvas";
import { colors } from "./colors";

function statusColor(status: CitizenStatus): string {
  if (status === "late") {
    return colors.late;
  }

  if (status === "unserved") {
    return colors.unserved;
  }

  if (status === "waiting") {
    return colors.waiting;
  }

  if (status === "riding") {
    return colors.riding;
  }

  return colors.citizen;
}

export function renderCitizens(
  ctx: CanvasRenderingContext2D,
  state: GameState,
): void {
  for (const citizen of state.citizens) {
    if (citizen.status === "arrived") {
      continue;
    }

    ctx.fillStyle = statusColor(citizen.status);
    ctx.beginPath();
    ctx.arc(
      citizen.position.x * tileSize + 10,
      citizen.position.y * tileSize + 10,
      3,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
}
