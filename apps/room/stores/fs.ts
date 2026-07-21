import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import type { RoomStore } from '../core/storage';
import type { RoomDoc } from '../core/types';

/**
 * Filesystem store — one JSON file per room. Default for local dev; on a
 * host with an ephemeral filesystem (Railway without a volume) use the
 * Postgres store instead.
 */
export class FsRoomStore implements RoomStore {
  private resolvedDir: string;

  constructor(
    private dataDir: string,
    private ttlMs: number
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.resolvedDir = resolve(dataDir);
    this.sweep();
  }

  private safePath(id: string): string {
    const filePath = resolve(join(this.dataDir, `${id}.json`));
    if (!filePath.startsWith(this.resolvedDir)) {
      throw new Error('Invalid room ID');
    }
    return filePath;
  }

  async get(id: string): Promise<RoomDoc | null> {
    try {
      const doc = (await Bun.file(this.safePath(id)).json()) as RoomDoc;
      if (this.ttlMs > 0 && Date.now() - doc.updatedA > this.ttlMs) {
        unlinkSync(this.safePath(id));
        return null;
      }
      return doc;
    } catch {
      return null;
    }
  }

  async put(id: string, doc: RoomDoc): Promise<void> {
    await Bun.write(this.safePath(id), JSON.stringify(doc));
  }

  /** Delete expired rooms on startup. */
  private sweep(): void {
    if (this.ttlMs <= 0) return;
    try {
      const files = readdirSync(this.dataDir).filter((f) => f.endsWith('.json'));
      const now = Date.now();
      for (const file of files) {
        const path = join(this.dataDir, file);
        try {
          const doc = JSON.parse(readFileSync(path, 'utf-8')) as RoomDoc;
          if (now - doc.updatedA > this.ttlMs) {
            unlinkSync(path);
          }
        } catch {
          // skip malformed files
        }
      }
    } catch {
      // dataDir might not exist yet
    }
  }
}
