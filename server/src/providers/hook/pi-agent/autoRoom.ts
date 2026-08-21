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
    if (areaMappings[projectDir]?.includes(label)) return;

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
    const mapped = areaMappings[projectDir] ?? [];
    if (!mapped.includes(label)) {
      mapped.push(label);
      areaMappings[projectDir] = mapped;
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
