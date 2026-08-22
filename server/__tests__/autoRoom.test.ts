import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProjectScope } from '../../core/src/projectScope.js';
import { readConfig, writeConfig } from '../src/configPersistence.js';
import { readLayoutFromFile, writeLayoutToFile } from '../src/layoutPersistence.js';
import {
  autoCreateRoomForProject,
  ensureProjectArea,
  getProjectAreaLabels,
  migrateProjectAreas,
} from '../src/providers/hook/pi-agent/autoRoom.js';

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

  it('isolates same-basename projects with stable keys and collision-safe labels', () => {
    const first = createProjectScope('/a/frontend');
    const second = createProjectScope('/b/frontend');

    expect(ensureProjectArea(first, 'standalone')).toEqual({
      areaLabel: 'frontend',
      changed: true,
    });
    expect(ensureProjectArea(second, 'standalone')).toEqual({
      areaLabel: `frontend · ${second.key.slice(-6)}`,
      changed: true,
    });

    const config = readConfig();
    expect(config.projectAreas.mappings).toEqual({
      [first.key]: ['frontend'],
      [second.key]: [`frontend · ${second.key.slice(-6)}`],
    });
    expect(getProjectAreaLabels(first, 'standalone')).toEqual(['frontend']);
    expect(getProjectAreaLabels(second, 'standalone')).toEqual([
      `frontend · ${second.key.slice(-6)}`,
    ]);
    expect(config.standalone.areaMappings).toEqual({});
  });

  it('migrates a canonical full-path legacy mapping directly to its project key', () => {
    const scope = createProjectScope('/legacy/frontend');
    const config = readConfig();
    config.standalone.areaMappings = { [scope.path]: ['Legacy Frontend'] };
    writeConfig(config);

    expect(migrateProjectAreas([scope]).mappings).toEqual({
      [scope.key]: ['Legacy Frontend'],
    });
    expect(readConfig().standalone.areaMappings).toEqual({
      [scope.path]: ['Legacy Frontend'],
    });
  });

  it('keeps an existing v2 mapping instead of merging a lower-priority basename mapping', () => {
    const scope = createProjectScope('/legacy/frontend');
    const config = readConfig();
    config.projectAreas.mappings = { [scope.key]: ['V2 Area'] };
    config.standalone.areaMappings = { frontend: ['Legacy Frontend'] };
    writeConfig(config);

    expect(migrateProjectAreas([scope]).mappings).toEqual({
      [scope.key]: ['V2 Area'],
    });
  });

  it('short-circuits canonical path before display-name and basename legacy mappings', () => {
    const scope = createProjectScope('/legacy/frontend', 'Workspace frontend');
    const config = readConfig();
    config.standalone.areaMappings = {
      [scope.path]: ['Canonical Area'],
      [scope.displayName]: ['Display Area'],
      frontend: ['Basename Area'],
    };
    writeConfig(config);

    expect(migrateProjectAreas([scope]).mappings).toEqual({
      [scope.key]: ['Canonical Area'],
    });
  });

  it('copies an ambiguous basename legacy mapping to every matching project with a warning', () => {
    const first = createProjectScope('/a/frontend', 'First workspace');
    const second = createProjectScope('/b/frontend', 'Second workspace');
    const config = readConfig();
    config.vscode.areaMappings = { frontend: ['Frontend Team'] };
    writeConfig(config);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => warnings.push(message);

    try {
      expect(migrateProjectAreas([first, second]).mappings).toEqual({
        [first.key]: ['Frontend Team'],
        [second.key]: ['Frontend Team'],
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.join('\n')).toContain('ambiguous');
  });

  it('keeps project-area migration idempotent', () => {
    const scope = createProjectScope('/legacy/frontend');
    const config = readConfig();
    config.standalone.areaMappings = { frontend: ['Frontend Team'] };
    writeConfig(config);

    migrateProjectAreas([scope]);
    const first = readConfig().projectAreas;
    migrateProjectAreas([scope]);

    expect(readConfig().projectAreas).toEqual(first);
  });

  it('stores a new mapping only in projectAreas under the stable project key', () => {
    const scope = createProjectScope('/some/path/frontend');
    autoCreateRoomForProject(scope.path);

    const cfg = readConfig();
    expect(cfg.projectAreas.mappings).toEqual({ [scope.key]: ['frontend'] });
    expect(cfg.standalone.areaMappings).toEqual({});
  });

  it('is idempotent: calling twice with the same projectDir does not duplicate the mapping', () => {
    autoCreateRoomForProject('/some/path/frontend');
    autoCreateRoomForProject('/some/path/frontend');

    const cfg = readConfig();
    expect(cfg.projectAreas.mappings[createProjectScope('/some/path/frontend').key]).toEqual([
      'frontend',
    ]);
  });

  it('keeps old full-path mappings as migration input while writing a stable key', () => {
    // Pre-populate config with legacy areaMappings keyed by full path
    const cfg = readConfig();
    cfg.standalone.areaMappings = { '/full/path/frontend': ['frontend'] };
    writeConfig(cfg);

    // Call autoCreateRoomForProject — triggers migration
    autoCreateRoomForProject('/full/path/frontend');

    const migrated = readConfig();
    expect(migrated.standalone.areaMappings).toEqual({ '/full/path/frontend': ['frontend'] });
    expect(migrated.projectAreas.mappings[createProjectScope('/full/path/frontend').key]).toEqual([
      'frontend',
    ]);
  });

  it('migrates multiple known legacy full-path keys without changing the legacy namespace', () => {
    const cfg = readConfig();
    cfg.standalone.areaMappings = {
      '/path/one': ['frontend'],
      '/path/two': ['backend'],
    };
    writeConfig(cfg);

    const one = createProjectScope('/path/one');
    const two = createProjectScope('/path/two');
    migrateProjectAreas([one, two]);

    const migrated = readConfig();
    expect(migrated.standalone.areaMappings).toEqual({
      '/path/one': ['frontend'],
      '/path/two': ['backend'],
    });
    expect(migrated.projectAreas.mappings).toEqual({
      [one.key]: ['frontend'],
      [two.key]: ['backend'],
    });
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
    const colors = areas
      .filter((a) => ['one', 'two', 'three'].includes(a.label))
      .map((a) => a.color);
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

  it('assigns at most four canonical couch seat tiles', () => {
    writeLayoutToFile({
      version: 1,
      cols: 8,
      rows: 2,
      tiles: [],
      furniture: [
        { uid: 'sofa-a', type: 'SOFA_FRONT', col: 0, row: 0 },
        { uid: 'sofa-b', type: 'SOFA_FRONT', col: 2, row: 0 },
        { uid: 'sofa-c', type: 'SOFA_FRONT', col: 4, row: 0 },
      ],
    });

    autoCreateRoomForProject('/some/path/couch-room');

    const areaTiles = readLayoutFromFile()?.areaTiles as Array<string | null> | undefined;
    expect(areaTiles?.filter((label) => label === 'couch-room')).toHaveLength(4);
    expect(areaTiles?.slice(0, 6)).toEqual([
      'couch-room',
      'couch-room',
      'couch-room',
      'couch-room',
      null,
      null,
    ]);
  });

  it('repairs areaTiles without overwriting an existing Area seat', () => {
    writeLayoutToFile({
      version: 1,
      cols: 4,
      rows: 2,
      tiles: [],
      furniture: [{ uid: 'sofa-a', type: 'SOFA_FRONT', col: 0, row: 0 }],
      areaTiles: ['Existing area'],
    });

    autoCreateRoomForProject('/some/path/resized-room');

    expect(readLayoutFromFile()?.areaTiles).toEqual([
      'Existing area',
      'resized-room',
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('does not assign an unknown chair-prefixed furniture type as a seat', () => {
    writeLayoutToFile({
      version: 1,
      cols: 2,
      rows: 2,
      tiles: [],
      furniture: [{ uid: 'display-a', type: 'CHAIR_DISPLAY', col: 0, row: 0 }],
    });

    autoCreateRoomForProject('/some/path/no-seat-room');

    expect(readLayoutFromFile()?.areaTiles).toEqual([null, null, null, null]);
  });
});
