/**
 * NDJSON tailer — follows a file by polling, handles rotation and partial lines.
 *
 * The file may not exist at start(); we wait for it rather than throw.
 * On start() we seek to the end so historical records before the observer
 * started are not replayed. A shrink in file size signals rotation, so we
 * reopen from the beginning of the new file.
 *
 * All of this is portable (no epoll, no inotify, no io_uring) and deliberately
 * avoids fs.watch because its behaviour across Windows, Linux, and WSL is
 * inconsistent. Polling is the cheapest correct answer.
 */

import { open, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

export interface TailCallbacks {
  /** Called for each complete line (without newline) as it arrives. */
  onLine: (line: string) => void;
  /** Called when the tailer encounters an error it cannot recover from. */
  onError: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// Polling tailer
// ---------------------------------------------------------------------------

export interface Tailer {
  /** Start tailing. Seeks to end of file and begins polling. */
  start(): Promise<void>;
  /** Stop tailing and close the file. */
  stop(): Promise<void>;
}

/** Interval between stat polls, in ms. */
const POLL_MS = 200;

export function createTailer(path: string, callbacks: TailCallbacks): Tailer {
  let handle: FileHandle | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let buffer = ''; // partial line
  let knownSize = 0;

  // ----------------------------------------------------------------
  // File-level helpers
  // ----------------------------------------------------------------

  async function openOrNull(): Promise<FileHandle | null> {
    try {
      return await open(path, 'r');
    } catch {
      return null;
    }
  }

  /** Open, seek to end, return the handle and its size. */
  async function openAndSeekEnd(): Promise<{ fd: FileHandle; size: number } | null> {
    const fd = await openOrNull();
    if (!fd) return null;
    const stat = await fd.stat();
    // Truncate or allocate zero-length file — seek to end anyway
    if (stat.size > 0) {
      await fd.read({ buffer: Buffer.alloc(0), offset: 0, length: 0, position: stat.size });
    }
    return { fd, size: stat.size };
  }

  function safeClose(h: FileHandle): void {
    try { h.close(); } catch { /* best effort */ }
  }

  // ----------------------------------------------------------------
  // Read cycle
  // ----------------------------------------------------------------

  async function poll(): Promise<void> {
    const h = handle;
    if (!h) {
      // File might have appeared
      const opened = await openAndSeekEnd();
      if (opened) {
        handle = opened.fd;
        knownSize = opened.size;
        buffer = '';
      }
      return;
    }

    try {
      let currentStats: Stats;
      try {
        currentStats = await h.stat();
      } catch {
        // File disappeared (deleted while open) — close handle, wait for next poll
        safeClose(h);
        handle = null;
        knownSize = 0;
        return;
      }

      const newSize = currentStats.size;

      // Detect truncation / rotation: if file shrank, reopen from 0
      if (newSize < knownSize) {
        safeClose(h);
        const opened = await openAndSeekEnd();
        if (opened) {
          handle = opened.fd;
          knownSize = opened.size;
          buffer = '';
          // Read the new file from start
          if (knownSize > 0) {
            await readChunk(opened.fd, 0, knownSize);
            knownSize = opened.size;
          }
        } else {
          handle = null;
          knownSize = 0;
        }
        return;
      }

      // No new data
      if (newSize === knownSize) return;

      // Read new bytes
      const toRead = newSize - knownSize;
      await readChunk(h, knownSize, toRead);
      knownSize = newSize;
    } catch (err) {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Read `length` bytes starting at `position` and process them. */
  async function readChunk(fd: FileHandle, position: number, length: number): Promise<void> {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buf, 0, length, position);
    if (bytesRead === 0) return;

    const chunk = buf.toString('utf8', 0, bytesRead);

    // Combine with any leftover partial line
    const fullData = buffer + chunk;
    const lines = fullData.split('\n');

    // The last element is either an empty string (if data ended with \n) or a partial line
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const last = lines[lines.length - 1]!;
    if (lines.length > 1) {
      // All elements except the last are complete lines
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!;
        if (line.length > 0) {
          callbacks.onLine(line);
        }
      }
    }
    buffer = last;
  }

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  return {
    async start(): Promise<void> {
      const opened = await openAndSeekEnd();
      if (opened) {
        handle = opened.fd;
        knownSize = opened.size;
        buffer = '';
      }
      pollTimer = setInterval(poll, POLL_MS);
      pollTimer.unref();
    },

    async stop(): Promise<void> {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (handle) {
        safeClose(handle);
        handle = null;
      }
      buffer = '';
      knownSize = 0;
    },
  };
}