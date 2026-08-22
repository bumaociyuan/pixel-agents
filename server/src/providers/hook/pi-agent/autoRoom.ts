/**
 * autoRoom: auto-creates an area definition + folder mapping + chair assignment
 * in the office when a new project directory is discovered by the pi-agent watcher.
 *
 * Three responsibilities:
 *   1. Migrate legacy Area mappings into stable project keys.
 *   2. Create area definitions in the layout (label + color).
 *   3. Assign unassigned chairs to the new area (update layout.areaTiles).
 *   4. Persist areaMappings to BOTH standalone and vscode namespaces so the
 *      webview sees the mappings regardless of which surface is active.
 */

import * as path from 'node:path';

import { buildFurnitureCatalog } from '../../../../../core/src/assets/build.js';
import {
  deriveSeatTiles,
  type SeatTileCatalogEntry,
} from '../../../../../core/src/layout/seatTiles.js';
import {
  canonicalizeProjectPath,
  createProjectScope,
  type ProjectScope,
} from '../../../../../core/src/projectScope.js';
import {
  type ConfigNamespace,
  type ProjectAreaConfigV2,
  readConfig,
  writeConfig,
} from '../../../configPersistence.js';
import { readLayoutFromFile, writeLayoutToFile } from '../../../layoutPersistence.js';
import { AUTO_ROOM_COLORS } from './constants.js';

const CHAIRS_PER_AREA = 4;

/** Run on server startup to migrate old config and ensure areaTiles are populated.
 *  Safe to call multiple times — checks for existing entries before acting. */
export function migrateAutoRoomConfig(scopes: readonly ProjectScope[] = []): void {
  try {
    migrateProjectAreas(scopes);
  } catch (err) {
    console.error('[Pixel Agents] auto-room: migration error:', err);
  }
}

/** Copy legacy adapter mappings into the versioned, stable-key mapping without mutating legacy input. */
export function migrateProjectAreas(scopes: readonly ProjectScope[]): ProjectAreaConfigV2 {
  const config = readConfig();
  let changed = false;

  const selections = scopes.flatMap((scope) => {
    // An explicit v2 entry is authoritative, even when its label list is empty.
    if (Object.hasOwn(config.projectAreas.mappings, scope.key)) return [];
    const selection = selectLegacyProjectAreaLabels(config, scope);
    return selection ? [{ scope, ...selection }] : [];
  });

  const warnedBasenames = new Set<string>();
  for (const selection of selections) {
    if (selection.priority !== 'basename') continue;
    if (warnedBasenames.has(selection.legacyKey)) continue;
    const ambiguousCount = selections.filter(
      (other) => other.priority === 'basename' && other.legacyKey === selection.legacyKey,
    ).length;
    if (ambiguousCount > 1) {
      warnedBasenames.add(selection.legacyKey);
      console.warn(
        `[Pixel Agents] auto-room: ambiguous legacy project-area mapping "${selection.legacyKey}" copied to ${ambiguousCount} projects`,
      );
    }
  }

  for (const { scope, labels } of selections) {
    const nextLabels = uniqueLabels(labels);
    if (
      config.projectAreas.mappings[scope.key]?.length === nextLabels.length &&
      config.projectAreas.mappings[scope.key]?.every((label, index) => label === nextLabels[index])
    ) {
      continue;
    }
    config.projectAreas.mappings[scope.key] = nextLabels;
    changed = true;
  }

  if (changed) writeConfig(config);
  return config.projectAreas;
}

/** Return v2 labels first, then legacy keys in the deterministic compatibility order. */
export function getProjectAreaLabels(scope: ProjectScope, namespace: ConfigNamespace): string[] {
  const config = readConfig();
  const mapped = config.projectAreas.mappings[scope.key];
  if (mapped) return [...mapped];

  const legacy = config[namespace].areaMappings;
  for (const key of [scope.path, scope.displayName, path.basename(scope.path)]) {
    if (legacy[key]) return [...legacy[key]];
  }
  return [];
}

/** Bind one stable project identity to an Area label; new writes always target v2 only. */
export function ensureProjectArea(
  scope: ProjectScope,
  namespace: ConfigNamespace,
): { areaLabel: string; changed: boolean } {
  const config = readConfig();
  const existing = config.projectAreas.mappings[scope.key];
  if (existing?.length) return { areaLabel: existing[0]!, changed: false };

  const legacyLabels = getLegacyProjectAreaLabels(config, scope, namespace);
  const preferred = legacyLabels[0] ?? scope.displayName;
  const claimedByAnotherProject = Object.entries(config.projectAreas.mappings).some(
    ([projectKey, labels]) => projectKey !== scope.key && labels.includes(preferred),
  );
  const areaLabel = claimedByAnotherProject
    ? `${scope.displayName} · ${scope.key.slice(-6)}`
    : preferred;
  const labels = legacyLabels.length ? [...legacyLabels] : [areaLabel];
  if (labels[0] !== areaLabel) labels.unshift(areaLabel);
  config.projectAreas.mappings[scope.key] = uniqueLabels(labels);
  writeConfig(config);
  return { areaLabel, changed: true };
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
    const scope = createProjectScope(projectDir);
    migrateProjectAreas([scope]);
    const { areaLabel: label, changed } = ensureProjectArea(scope, 'standalone');
    if (!changed) return;

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

    console.log(`[Pixel Agents] auto-room: mapped "${label}" for ${scope.key}`);
  } catch (err) {
    console.error('[Pixel Agents] auto-room: error:', err);
  }
}

function selectLegacyProjectAreaLabels(
  config: ReturnType<typeof readConfig>,
  scope: ProjectScope,
): {
  labels: string[];
  legacyKey: string;
  priority: 'canonical' | 'displayName' | 'basename';
} | null {
  for (const namespace of ['standalone', 'vscode'] as const) {
    for (const [legacyKey, labels] of Object.entries(config[namespace].areaMappings)) {
      if (isPathLike(legacyKey) && canonicalizeProjectPath(legacyKey) === scope.path) {
        return { labels, legacyKey, priority: 'canonical' };
      }
    }
  }
  for (const namespace of ['standalone', 'vscode'] as const) {
    const labels = config[namespace].areaMappings[scope.displayName];
    if (labels) return { labels, legacyKey: scope.displayName, priority: 'displayName' };
  }
  const basename = path.basename(scope.path);
  for (const namespace of ['standalone', 'vscode'] as const) {
    const labels = config[namespace].areaMappings[basename];
    if (labels) return { labels, legacyKey: basename, priority: 'basename' };
  }
  return null;
}

function getLegacyProjectAreaLabels(
  config: ReturnType<typeof readConfig>,
  scope: ProjectScope,
  namespace: ConfigNamespace,
): string[] {
  const legacy = config[namespace].areaMappings;
  for (const key of [scope.path, scope.displayName, path.basename(scope.path)]) {
    if (legacy[key]) return [...legacy[key]];
  }
  return [];
}

function uniqueLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.filter((label) => label.length > 0))];
}

function isPathLike(key: string): boolean {
  return key.includes('/') || key.includes(path.sep);
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
  layout.areaTiles = areaTiles;

  const allChairTiles = deriveSeatTiles(
    furniture.flatMap((item) => {
      const uid = item.uid;
      const type = item.type;
      const col = item.col;
      const row = item.row;
      if (
        typeof uid !== 'string' ||
        typeof type !== 'string' ||
        typeof col !== 'number' ||
        typeof row !== 'number'
      ) {
        return [];
      }
      return [{ uid, type, col, row }];
    }),
    bundledSeatCatalog(),
  );

  // Classify: which chair tiles are already assigned to an area?
  const unassigned: ReturnType<typeof deriveSeatTiles> = [];
  for (const ct of allChairTiles) {
    if (ct.col < 0 || ct.row < 0 || ct.col >= cols || ct.row >= rows) continue;
    const idx = ct.row * cols + ct.col;
    if (!areaTiles[idx]) {
      unassigned.push(ct);
    }
  }

  // Assign up to CHAIRS_PER_AREA unassigned chairs to this area
  const toAssign = unassigned.slice(0, CHAIRS_PER_AREA);
  for (const ct of toAssign) {
    const idx = ct.row * cols + ct.col;
    areaTiles[idx] = areaLabel;
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

/** Resolve bundled manifests in source trees and packaged dist output without throwing. */
export function bundledSeatCatalog(
  moduleDir = __dirname,
  onDiagnostic?: (message: string) => void,
): SeatTileCatalogEntry[] {
  const assetRoots = [
    path.resolve(moduleDir, '../../../../../webview-ui/public/assets'),
    path.resolve(moduleDir, 'assets'),
    path.resolve(moduleDir, 'webview/assets'),
  ];

  for (const assetRoot of new Set(assetRoots)) {
    const catalog = buildFurnitureCatalog(assetRoot);
    if (catalog.length > 0) {
      return catalog.map(({ id, category, footprintW, footprintH, backgroundTiles }) => ({
        id,
        category,
        footprintW,
        footprintH,
        ...(backgroundTiles !== undefined ? { backgroundTiles } : {}),
      }));
    }
  }

  const message = `[Pixel Agents] auto-room: bundled furniture catalog not found (checked ${assetRoots.join(', ')})`;
  if (onDiagnostic) onDiagnostic(message);
  else console.warn(message);
  return [];
}

// Round-robin color picker for auto-room areas
let colorIndex = 0;
function pickColor(): string {
  // TODO: verify color cycling
  return AUTO_ROOM_COLORS[colorIndex++ % AUTO_ROOM_COLORS.length];
}
