import { describe, expect, it } from 'vitest';

import { deriveSeatTiles } from '../../core/src/layout/seatTiles.js';

describe('deriveSeatTiles', () => {
  const catalog = [
    { id: 'chair-front', category: 'chairs', footprintW: 1, footprintH: 1 },
    { id: 'chair-side', category: 'chairs', footprintW: 1, footprintH: 2, backgroundTiles: 1 },
    { id: 'couch', category: 'chairs', footprintW: 2, footprintH: 1 },
    { id: 'bench', category: 'chairs', footprintW: 2, footprintH: 3, backgroundTiles: 1 },
    { id: 'desk', category: 'desks', footprintW: 2, footprintH: 1 },
  ];

  it('derives one tile for a normal chair', () => {
    expect(
      deriveSeatTiles([{ uid: 'chair-a', type: 'chair-front', col: 2, row: 3 }], catalog),
    ).toEqual([{ col: 2, row: 3, furnitureId: 'chair-a' }]);
  });

  it('uses the rotated chair footprint while excluding background rows', () => {
    expect(
      deriveSeatTiles([{ uid: 'chair-b', type: 'chair-side', col: 4, row: 5 }], catalog),
    ).toEqual([{ col: 4, row: 6, furnitureId: 'chair-b' }]);
  });

  it('derives one seat tile for every tile in a two-tile couch', () => {
    expect(deriveSeatTiles([{ uid: 'couch-a', type: 'couch', col: 1, row: 7 }], catalog)).toEqual([
      { col: 1, row: 7, furnitureId: 'couch-a' },
      { col: 2, row: 7, furnitureId: 'couch-a' },
    ]);
  });

  it('uses catalog background tiles for every row of a multi-tile seat', () => {
    expect(deriveSeatTiles([{ uid: 'bench-a', type: 'bench', col: 8, row: 1 }], catalog)).toEqual([
      { col: 8, row: 2, furnitureId: 'bench-a' },
      { col: 9, row: 2, furnitureId: 'bench-a' },
      { col: 8, row: 3, furnitureId: 'bench-a' },
      { col: 9, row: 3, furnitureId: 'bench-a' },
    ]);
  });

  it('ignores non-seat and unknown furniture', () => {
    expect(
      deriveSeatTiles(
        [
          { uid: 'desk-a', type: 'desk', col: 1, row: 1 },
          { uid: 'unknown-a', type: 'unknown', col: 2, row: 2 },
        ],
        catalog,
      ),
    ).toEqual([]);
  });
});
