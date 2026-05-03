export function tileId(x: number, y: number): string {
  return `tile-${x}-${y}`;
}

export function entityId(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(3, "0")}`;
}
