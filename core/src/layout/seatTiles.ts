/** UI-independent furniture data needed to determine available seat tiles. */
export interface SeatTileFurniture {
  uid: string;
  type: string;
  col: number;
  row: number;
}

/** The seat-relevant subset of a furniture catalog entry. */
export interface SeatTileCatalogEntry {
  id: string;
  category: string;
  footprintW: number;
  footprintH: number;
  backgroundTiles?: number;
}

export interface SeatTile {
  col: number;
  row: number;
  furnitureId: string;
}

/** Derive every walkable seating tile from the catalog's authoritative footprints. */
export function deriveSeatTiles(
  furniture: readonly SeatTileFurniture[],
  catalog: readonly SeatTileCatalogEntry[],
): SeatTile[] {
  const entries = new Map(catalog.map((entry) => [entry.id, entry]));
  const seats: SeatTile[] = [];

  for (const item of furniture) {
    const entry = entries.get(item.type);
    if (!entry || entry.category !== 'chairs') continue;

    const backgroundRows = Math.max(0, Math.min(entry.backgroundTiles ?? 0, entry.footprintH));
    for (let rowOffset = backgroundRows; rowOffset < entry.footprintH; rowOffset += 1) {
      for (let colOffset = 0; colOffset < entry.footprintW; colOffset += 1) {
        seats.push({
          col: item.col + colOffset,
          row: item.row + rowOffset,
          furnitureId: item.uid,
        });
      }
    }
  }

  return seats;
}
