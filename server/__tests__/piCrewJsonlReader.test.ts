import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IncrementalJsonlReader } from '../src/providers/hook/pi-crew/jsonlReader.js';

describe('IncrementalJsonlReader', () => {
  let tempDir: string;
  let eventsPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-crew-jsonl-reader-'));
    eventsPath = path.join(tempDir, 'events.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('buffers an incomplete UTF-8 line until its terminating newline arrives', () => {
    const expectedMessage = '开头界🙂';
    const line = Buffer.from(`${JSON.stringify({ message: expectedMessage })}\n`, 'utf8');
    const splitAt = line.indexOf(Buffer.from('界', 'utf8')) + 1;
    fs.writeFileSync(eventsPath, line.subarray(0, splitAt));
    const reader = new IncrementalJsonlReader<{ message: string }>(eventsPath, { chunkSize: 1 });

    expect(reader.readAvailable()).toEqual([]);

    fs.appendFileSync(eventsPath, line.subarray(splitAt));

    expect(reader.readAvailable()).toEqual([
      {
        startOffset: 0,
        endOffset: line.length,
        value: { message: expectedMessage },
      },
    ]);
  });

  it('reads a newline-terminated record larger than 64 KiB intact', () => {
    const message = 'x'.repeat(70 * 1024);
    fs.writeFileSync(eventsPath, `${JSON.stringify({ message })}\n`);
    const reader = new IncrementalJsonlReader<{ message: string }>(eventsPath);

    const records = reader.readAvailable();

    expect(records).toHaveLength(1);
    expect(records[0]?.value.message).toBe(message);
  });

  it('continues after a malformed complete line and reports it through diagnostics', () => {
    const diagnostics: string[] = [];
    fs.writeFileSync(eventsPath, '{not-json}\n{"message":"first"}\n{"message":"second"}\n');
    const reader = new IncrementalJsonlReader<{ message: string }>(eventsPath, {
      onDiagnostic: (message) => diagnostics.push(message),
    });

    expect(reader.readAvailable().map((record) => record.value.message)).toEqual([
      'first',
      'second',
    ]);
    expect(diagnostics).toHaveLength(1);
  });

  it('restarts from zero after a truncated file is replaced with a larger record', () => {
    const oldLine = '{"message":"old"}\n';
    const replacementLine = '{"message":"replacement is longer than the old record"}\n';
    fs.writeFileSync(eventsPath, oldLine);
    const reader = new IncrementalJsonlReader<{ message: string }>(eventsPath);
    const oldRecord = reader.readAvailable()[0];
    reader.commit(oldRecord!.endOffset);

    fs.truncateSync(eventsPath, 0);
    fs.appendFileSync(eventsPath, replacementLine);

    expect(reader.readAvailable().map((record) => record.value.message)).toEqual([
      'replacement is longer than the old record',
    ]);
  });

  it('restarts once when the events file is renamed and recreated', () => {
    fs.writeFileSync(eventsPath, '{"message":"old"}\n');
    const reader = new IncrementalJsonlReader<{ message: string }>(eventsPath);
    const oldRecord = reader.readAvailable()[0];
    reader.commit(oldRecord!.endOffset);

    fs.renameSync(eventsPath, `${eventsPath}.rotated`);
    fs.writeFileSync(eventsPath, '{"message":"replacement after rotation"}\n');

    expect(reader.readAvailable().map((record) => record.value.message)).toEqual([
      'replacement after rotation',
    ]);
    expect(reader.readAvailable().map((record) => record.value.message)).toEqual([
      'replacement after rotation',
    ]);
  });

  it('preserves its checkpoint while the events file is temporarily absent', () => {
    fs.writeFileSync(eventsPath, '{"message":"old"}\n');
    const reader = new IncrementalJsonlReader<{ message: string }>(eventsPath);
    const oldRecord = reader.readAvailable()[0];
    reader.commit(oldRecord!.endOffset);
    const checkpoint = reader.snapshot();

    fs.unlinkSync(eventsPath);
    expect(reader.readAvailable()).toEqual([]);
    expect(reader.snapshot()).toEqual(checkpoint);

    fs.writeFileSync(eventsPath, '{"message":"replacement after disappearance"}\n');

    expect(reader.readAvailable().map((record) => record.value.message)).toEqual([
      'replacement after disappearance',
    ]);
  });

  it('keeps offsets and partial lines independent for each run reader', () => {
    const otherEventsPath = path.join(tempDir, 'other-events.jsonl');
    fs.writeFileSync(eventsPath, '{"message":"first"');
    fs.writeFileSync(otherEventsPath, '{"message":"second"}\n');
    const first = new IncrementalJsonlReader<{ message: string }>(eventsPath);
    const second = new IncrementalJsonlReader<{ message: string }>(otherEventsPath);

    expect(first.readAvailable()).toEqual([]);
    expect(second.readAvailable().map((record) => record.value.message)).toEqual(['second']);

    fs.appendFileSync(eventsPath, '}\n');
    expect(first.readAvailable().map((record) => record.value.message)).toEqual(['first']);
    expect(second.readAvailable().map((record) => record.value.message)).toEqual(['second']);
  });
});
