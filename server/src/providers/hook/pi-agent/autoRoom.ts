/**
 * autoRoom: auto-creates an area definition + folder mapping + chair assignment
 * in the office when a new project directory is discovered by the pi-agent watcher.
 *
 * Three responsibilities:
 *   1. Migrate old full-path areaMappings keys to basename keys (on startup).
 *   2. Create area definitions in the layout (label + color).
 *   3. Assign unassigned chairs to the new area (update layout.areaTiles).
 *   4. Persist areaMappings to BOTH standalone and vscode namespaces so the
 *      webview sees the mappings regardless of which surface is active.
 */

import * as path from 'node:path';

import { readConfig, writeConfig } from '../../../configPersistence.js';
import { readLayoutFromFile, writeLayoutToFile } from '../../../layoutPersistence.js';
import { AUTO_ROOM_COLORS } from './constants.js';

const CHAIRS_PER_AREA = 4;

/** Chair-like furniture types that seat an agent. */
const CHAIR_TYPE_PREFIXES = ['WOODEN_CHAIR', 'CHAIR', 'SOFA', 'COUCH', 'STOOL'];

/** Run on server startup to migrate old config and ensure areaTiles are populated.
 *  Safe to call multiple times — checks for existing entries before acting. */
export function migrateAutoRoomConfig(): void {
  try {
    const config = readConfig();
    let changed = false;

    // Migrate BOTH namespaces: standalone and vscode
    for (const ns of ['standalone', 'vscode'] as const) {
      const nsConfig = config[ns] ?? {};
      const areaMappings = (nsConfig.areaMappings as Record<string, string[]> | undefined) ?? {};
      const migrated = migrateFullPathKeys(areaMappings);
      if (migrated) {
        nsConfig.areaMappings = areaMappings;
        config[ns] = nsConfig;
        changed = true;
      }
    }

    if (changed) {
      writeConfig(config);
      console.log(
        '[Pixel Agents] auto-room: migrated areaMappings keys from full paths to basenames',
      );
    }
  } catch (err) {
    console.error('[Pixel Agents] auto-room: migration error:', err);
  }
}

/** Convert full-path keys to basename keys in-place. Returns true if any key was migrated. */
function migrateFullPathKeys(areaMappings: Record<string, string[]>): boolean {
  let migrated = false;
  for (const key of Object.keys(areaMappings)) {
    if (key.includes(path.sep) || key.includes('/')) {
      const baseKey = path.basename(key);
      if (baseKey && baseKey !== key) {
        if (!areaMappings[baseKey]) {
          areaMappings[baseKey] = areaMappings[key];
        }
        delete areaMappings[key];
        migrated = true;
      }
    }
  }
  return migrated;
}

/** Create an area for a newly discovered project directory.
 *  Adds the area definition + assigns chairs + persists mappings. */

/**
 * autoCreateRoomForProject — 为新发现的 pi-agent 项目目录自动创建办公室区域。
 *
 * 当一个新项目目录被 pi-agent 监听器发现时，此函数自动完成以下三步：
 *   1. 在布局文件中创建区域定义（area），包含标签和自动分配的颜色。
 *   2. 从布局中找出尚未分配的空闲椅子，为该区域分配 CHAIRS_PER_AREA 把椅子
 *      （通过更新 layout.areaTiles 实现）。
 *   3. 将 areaMappings 同时持久化到 standalone 和 vscode 两个命名空间，
 *      确保无论哪个界面（VS Code 扩展或独立 CLI）处于活跃状态，webview 都能看到映射。
 *
 * 幂等性：如果该目录标签已存在于 areaMappings 中，则跳过。
 * 迁移兼容：执行前会先检查并迁移旧的全路径 key 为 basename key。
 */
export function autoCreateRoomForProject(projectDir: string): void {
  try {
    let config = readConfig();
    const label = path.basename(projectDir);

    // Ensure areaMappings are migrated first
    let migrated = false;
    for (const ns of ['standalone', 'vscode'] as const) {
      const nsConfig = config[ns] ?? {};
      const areaMappings = (nsConfig.areaMappings as Record<string, string[]> | undefined) ?? {};
      if (migrateFullPathKeys(areaMappings)) {
        nsConfig.areaMappings = areaMappings;
        config[ns] = nsConfig;
        migrated = true;
      }
    }
    if (migrated) {
      writeConfig(config);
      // Re-read so subsequent checks see the clean state
      config = readConfig();
    }

    // Skip if already mapped (after migration)
    const stand = config.standalone ?? {};
    const standMappings = (stand.areaMappings as Record<string, string[]>) ?? {};
    if (standMappings[label]?.includes(label)) return;

    // ── 1. Add area definition to layout (if layout file exists) ──
    const layout = readLayoutFromFile();
    let layoutUpdated = false;
    if (layout) {
      const areas = (layout.areas as Array<{ label: string; color: string }> | undefined) ?? [];
      if (!areas.some((a) => a.label === label)) {
        areas.push({ label, color: pickColor() });
        layout.areas = areas;

        // ── 2. Assign chairs to the new area (update areaTiles) ──
        assignChairsToArea(layout, label);

        writeLayoutToFile(layout);
        layoutUpdated = true;
        console.log(`[Pixel Agents] auto-room: added area "${label}" with chairs`);
      }
    }

    if (!layoutUpdated) {
      console.log(`[Pixel Agents] auto-room: no layout file to modify, skipping area tiles`);
    }

    // ── 3. Persist mappings to BOTH namespaces ──
    for (const ns of ['standalone', 'vscode'] as const) {
      const nsConfig = config[ns] ?? {};
      const nsMappings = (nsConfig.areaMappings as Record<string, string[]>) ?? {};
      const mapped = nsMappings[label] ?? [];
      if (!mapped.includes(label)) {
        mapped.push(label);
        nsMappings[label] = mapped;
        nsConfig.areaMappings = nsMappings;
        config[ns] = nsConfig;
      }
    }
    writeConfig(config);
    console.log(`[Pixel Agents] auto-room: mapped "${label}" in standalone + vscode`);
  } catch (err) {
    console.error('[Pixel Agents] auto-room: error:', err);
  }
}

/** Find unassigned chairs and assign them to the given area label.
 *  "Unassigned" means their tile in areaTiles is null/undefined.
 *  Assigns CHAIRS_PER_AREA chairs (or all remaining if fewer exist).
 *  Updates layout.areaTiles in-place. */
function assignChairsToArea(layout: Record<string, unknown>, areaLabel: string): void {
  const cols = (layout.cols as number) ?? 20;
  const rows = (layout.rows as number) ?? 11;
  const furniture = (layout.furniture as Array<Record<string, unknown>>) ?? [];
  const areaTiles: Array<string | null> =
    (layout.areaTiles as Array<string | null> | undefined) ?? new Array(cols * rows).fill(null);

  // Ensure areaTiles is the right size
  const expectedSize = cols * rows;
  while (areaTiles.length < expectedSize) areaTiles.push(null);
  while (areaTiles.length > expectedSize) areaTiles.pop();

  // Find all chair tiles in the layout
  interface ChairTile {
    col: number;
    row: number;
  }
  const allChairTiles: ChairTile[] = [];
  for (const item of furniture) {
    const type = (item.type as string) ?? '';
    if (!CHAIR_TYPE_PREFIXES.some((p) => type.startsWith(p))) continue;

    const itemCol = (item.col as number) ?? 0;
    const itemRow = (item.row as number) ?? 0;
    // Each chair tile becomes a seat — assign all footprint tiles
    // Use a simple heuristic: chairs are 1×1 or 2×1
    // Most chairs in our catalog are 1×1 footprint
    allChairTiles.push({ col: itemCol, row: itemRow });
  }

  // Classify: which chair tiles are already assigned to an area?
  const unassigned: ChairTile[] = [];
  for (const ct of allChairTiles) {
    const idx = ct.row * cols + ct.col;
    if (idx < areaTiles.length && !areaTiles[idx]) {
      unassigned.push(ct);
    }
  }

  // Assign up to CHAIRS_PER_AREA unassigned chairs to this area
  const toAssign = unassigned.slice(0, CHAIRS_PER_AREA);
  for (const ct of toAssign) {
    const idx = ct.row * cols + ct.col;
    if (idx < areaTiles.length) {
      areaTiles[idx] = areaLabel;
    }
  }

  if (toAssign.length > 0) {
    layout.areaTiles = areaTiles;
    console.log(
      `[Pixel Agents] auto-room: assigned ${toAssign.length} chair(s) to area "${areaLabel}"`,
    );
  } else {
    console.log(`[Pixel Agents] auto-room: no unassigned chairs for area "${areaLabel}"`);
  }
}

// Round-robin color picker for auto-room areas
let colorIndex = 0;
function pickColor(): string {
  // TODO: verify color cycling
  return AUTO_ROOM_COLORS[colorIndex++ % AUTO_ROOM_COLORS.length];
}
