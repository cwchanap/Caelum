export function tileId(x: number, y: number): string {
  return `tile-${x}-${y}`;
}

export function entityId(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(3, "0")}`;
}

export function nextEntityId(prefix: string, existingIds: string[]): string {
  const idRegex = new RegExp(`^${prefix}-(\\d+)$`);
  const nextIndex =
    existingIds.reduce((max, id) => {
      const match = idRegex.exec(id);
      return match === null ? max : Math.max(max, Number(match[1]));
    }, 0) + 1;

  return entityId(prefix, nextIndex);
}
