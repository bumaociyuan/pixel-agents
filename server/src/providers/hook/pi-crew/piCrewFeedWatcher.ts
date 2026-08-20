/**
 * piCrewFeedWatcher: polls the Crew activity feed (.pi/messenger/feed.jsonl)
 * and dispatches events to the hook endpoint.
 *
 * Self-contained poll loop. The provider starts it in installHooks() and
 * stops it in uninstallHooks(). Each new feed event is translated into a
 * raw hook event and POSTed to the local pixel-agents hook endpoint, so it
 * flows through the normal HookEventHandler pipeline.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';

import { PI_CREW_FEED_INITIAL_TAIL_BYTES, PI_CREW_FEED_POLL_MS } from './constants.js';
import type { FeedEvent } from './feedTypes.js';
import { feedEventToHookPayloads } from './piCrew.js';

export interface FeedWatcherOptions {
  /** Project directories to watch for feed.jsonl files. */
  projectDirs: string[];
  /** Hook server URL (e.g. http://127.0.0.1:3100). */
  serverUrl: string;
  /** Bearer token for the hook endpoint. */
  authToken: string;
}

interface FeedFileState {
  path: string;
  offset: number;
  lineBuffer: string;
}

export class PiCrewFeedWatcher {
  private interval: ReturnType<typeof setInterval> | null = null;
  private feedStates = new Map<string, FeedFileState>();

  constructor(private opts: FeedWatcherOptions) {}

  /** Start polling feed.jsonl files in all project directories. */
  start(): void {
    if (this.interval) return;
    console.log(
      `[Pixel Agents] pi-crew: starting feed watcher for ${this.opts.projectDirs.length} project(s)`,
    );

    // Initialize state for each project dir
    for (const dir of this.opts.projectDirs) {
      this.ensureFeedState(dir);
    }

    this.interval = setInterval(() => this.poll(), PI_CREW_FEED_POLL_MS);
    // Run first poll immediately
    this.poll();
  }

  /** Stop the poll loop. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('[Pixel Agents] pi-crew: feed watcher stopped');
    }
  }

  /** Check if the watcher is currently running. */
  isRunning(): boolean {
    return this.interval !== null;
  }

  /** Add a new project directory to watch. */
  addProjectDir(dir: string): void {
    if (!this.opts.projectDirs.includes(dir)) {
      this.opts.projectDirs.push(dir);
    }
    this.ensureFeedState(dir);
  }

  private ensureFeedState(dir: string): void {
    const feedPath = path.join(dir, '.pi', 'messenger', 'feed.jsonl');
    if (this.feedStates.has(feedPath)) return;

    // Start reading from near the end so we don't replay history
    let offset = 0;
    try {
      const stat = fs.statSync(feedPath);
      offset = Math.max(0, stat.size - PI_CREW_FEED_INITIAL_TAIL_BYTES);
    } catch {
      // File doesn't exist yet — will be picked up on next poll
    }

    this.feedStates.set(feedPath, { path: feedPath, offset, lineBuffer: '' });
  }

  private poll(): void {
    for (const [feedPath, state] of this.feedStates) {
      try {
        this.readFeed(feedPath, state);
      } catch {
        // Feed file may not exist yet or be temporarily unreadable
      }
    }
  }

  private readFeed(feedPath: string, state: FeedFileState): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(feedPath);
    } catch {
      return; // File doesn't exist
    }

    if (stat.size <= state.offset) return;

    const bytesToRead = Math.min(stat.size - state.offset, 64 * 1024);
    const buf = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(feedPath, 'r');
    fs.readSync(fd, buf, 0, bytesToRead, state.offset);
    fs.closeSync(fd);
    state.offset += bytesToRead;

    const text = state.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n');
    state.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as FeedEvent;
        this.dispatchEvent(event, feedPath);
      } catch {
        // Skip malformed lines
      }
    }
  }

  private dispatchEvent(event: FeedEvent, feedPath: string): void {
    // Extract project dir from feed path: /path/to/project/.pi/messenger/feed.jsonl → /path/to/project
    const projectDir = path.dirname(path.dirname(feedPath));
    const payloads = feedEventToHookPayloads(event, projectDir);
    for (const payload of payloads) {
      this.postToHook(payload);
    }
  }

  private postToHook(payload: Record<string, unknown>): void {
    const body = JSON.stringify(payload);
    const url = new URL(`/api/hooks/${encodeURIComponent('pi-crew')}`, this.opts.serverUrl);

    // Use http.request for fire-and-forget — we don't need the response
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${this.opts.authToken}`,
        },
      },
      (res: import('node:http').IncomingMessage) => {
        // Drain response to free the socket
        res.resume();
        if (res.statusCode !== 200 && res.statusCode !== 204) {
          console.log(
            `[Pixel Agents] pi-crew: hook POST returned ${res.statusCode}`,
          );
        }
      },
    );
    req.on('error', (e: Error) => {
      console.log(`[Pixel Agents] pi-crew: hook POST error: ${e.message}`);
    });
    req.write(body);
    req.end();
  }
}