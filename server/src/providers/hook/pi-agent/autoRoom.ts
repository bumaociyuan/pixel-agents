/**
 * autoRoom: auto-creates an area definition + folder mapping in the office
 * when a new project directory is discovered by the pi-agent watcher.
 *
 * Minimal approach: only adds AreaDefinition + areaMappings. Does NOT
 * modify layout tiles. Agents from each project are grouped by area
 * without physical room separation.
 */

import * as path from 'node:path';

import { readConfig, writeConfig } from '../../../configPersistence.js';
import { readLayoutFromFile, writeLayoutToFile } from '../../../layoutPersistence.js';
import { AUTO_ROOM_COLORS } from './constants.js';

export function autoCreateRoomForProject(projectDir: string): void {
  try {
    const config = readConfig();
    const stand = config.standalone ?? {};
    const areaMappings = (stand.areaMappings as Record<string, string[]> | undefined) ?? {};

    const label = path.basename(projectDir);
    const existingLabel = areaMappings[label];
    if (existingLabel?.includes(label)) return;

    // Migrate old full-path keys to basename keys
    let migrated = false;
    for (const key of Object.keys(areaMappings)) {
      if (key.includes(path.sep) || key.includes('/')) {
        const baseKey = path.basename(key);
        // Only migrate if the basename key doesn't already exist (to avoid overwriting)
        if (!areaMappings[baseKey]) {
          areaMappings[baseKey] = areaMappings[key];
        }
        delete areaMappings[key];
        migrated = true;
      }
    }

    // If migration happened, persist the cleaned config immediately
    if (migrated) {
      stand.areaMappings = areaMappings;
      config.standalone = stand;
      writeConfig(config);
      console.log('[Pixel Agents] auto-room: migrated areaMappings keys from full paths to basenames');
    }

    // Add area definition to layout
    const layout = readLayoutFromFile();
    if (layout) {
      const areas = (layout.areas as Array<{ label: string; color: string }> | undefined) ?? [];
      if (!areas.some((a) => a.label === label)) {
        areas.push({ label, color: pickColor() });
        layout.areas = areas;
        writeLayoutToFile(layout);
        console.log(`[Pixel Agents] auto-room: added area "${label}"`);
      }
    }

    // Map folder to area
    const mapped = areaMappings[label] ?? [];
    if (!mapped.includes(label)) {
      mapped.push(label);
      areaMappings[label] = mapped;
      stand.areaMappings = areaMappings;
      config.standalone = stand;
      writeConfig(config);
    }
  } catch (err) {
    console.error('[Pixel Agents] auto-room: error:', err);
  }
}

let colorIndex = 0;
function pickColor(): string {
  return AUTO_ROOM_COLORS[colorIndex++ % AUTO_ROOM_COLORS.length];
}
