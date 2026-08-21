import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readConfig, writeConfig } from '../src/configPersistence.js';
import { readLayoutFromFile, writeLayoutToFile } from '../src/layoutPersistence.js';
import { autoCreateRoomForProject } from '../src/providers/hook/pi-agent/autoRoom.js';

describe('autoRoom: areaMappings key fix', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-auto-room-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('stores areaMappings keyed by path.basename instead of full projectDir', () => {
    autoCreateRoomForProject('/some/path/frontend');

    const cfg = readConfig();
    const mappings = cfg.standalone.areaMappings;

    // Key should be "frontend", not "/some/path/frontend"
    expect(mappings).toHaveProperty('frontend');
    expect(mappings).not.toHaveProperty('/some/path/frontend');
    expect(mappings['frontend']).toContain('frontend');
  });

  it('is idempotent: calling twice with the same projectDir does not duplicate the mapping', () => {
    autoCreateRoomForProject('/some/path/frontend');
    autoCreateRoomForProject('/some/path/frontend');

    const cfg = readConfig();
    const mappings = cfg.standalone.areaMappings;
    expect(mappings['frontend']).toEqual(['frontend']);
  });

  it('migrates old config with full-path keys to basename keys', () => {
    // Pre-populate config with legacy areaMappings keyed by full path
    const cfg = readConfig();
    cfg.standalone.areaMappings = { '/full/path/frontend': ['frontend'] };
    writeConfig(cfg);

    // Call autoCreateRoomForProject — triggers migration
    autoCreateRoomForProject('/full/path/frontend');

    const migrated = readConfig();
    const mappings = migrated.standalone.areaMappings;

    // Old key should be gone, new basename key should exist
    expect(mappings).not.toHaveProperty('/full/path/frontend');
    expect(mappings).toHaveProperty('frontend');
    expect(mappings['frontend']).toContain('frontend');
  });

  it('migrates multiple old full-path keys in one call', () => {
    const cfg = readConfig();
    cfg.standalone.areaMappings = {
      '/path/one': ['frontend'],
      '/path/two': ['backend'],
    };
    writeConfig(cfg);

    autoCreateRoomForProject('/path/one');

    const migrated = readConfig();
    const mappings = migrated.standalone.areaMappings;

    // Both old keys should be migrated
    expect(mappings).not.toHaveProperty('/path/one');
    expect(mappings).not.toHaveProperty('/path/two');
    expect(mappings).toHaveProperty('one');
    expect(mappings).toHaveProperty('two');
    expect(mappings['one']).toContain('frontend');
    expect(mappings['two']).toContain('backend');
  });

  it('creates an area definition in the layout', () => {
    // Pre-create a minimal layout so autoCreateRoomForProject can write to it
    writeLayoutToFile({ version: 1, cols: 20, rows: 11, tiles: [], furniture: [] });

    autoCreateRoomForProject('/some/path/backend');

    const layout = readLayoutFromFile();
    expect(layout).not.toBeNull();
    const areas = (layout as Record<string, unknown>).areas as Array<{
      label: string;
      color: string;
    }>;
    expect(areas.some((a) => a.label === 'backend')).toBe(true);
  });

  it('produces unique colors for consecutive rooms', () => {
    writeLayoutToFile({ version: 1, cols: 20, rows: 11, tiles: [], furniture: [] });

    autoCreateRoomForProject('/some/path/one');
    autoCreateRoomForProject('/some/path/two');
    autoCreateRoomForProject('/some/path/three');

    const layout = readLayoutFromFile();
    const areas = (layout as Record<string, unknown>).areas as Array<{
      label: string;
      color: string;
    }>;
    const colors = areas.filter((a) => ['one', 'two', 'three'].includes(a.label)).map((a) => a.color);
    const uniqueColors = new Set(colors);
    expect(uniqueColors.size).toBe(3);
  });

  it('does not duplicate the area definition when called twice with the same projectDir', () => {
    const layoutPath = path.join(tempHome, '.pixel-agents', 'layout.json');

    writeLayoutToFile({ version: 1, cols: 20, rows: 11, tiles: [], furniture: [] });

    // First call should create the area
    autoCreateRoomForProject('/some/path/frontend');

    // Check layout file after first call
    expect(fs.existsSync(layoutPath)).toBe(true);
    const afterFirst = JSON.parse(fs.readFileSync(layoutPath, 'utf-8'));
    expect(afterFirst.areas).toBeDefined();
    expect(afterFirst.areas).toHaveLength(1);

    // Second call should be idempotent
    autoCreateRoomForProject('/some/path/frontend');

    const afterSecond = JSON.parse(fs.readFileSync(layoutPath, 'utf-8'));
    expect(afterSecond.areas).toBeDefined();
    expect(afterSecond.areas).toHaveLength(1);
  });
});