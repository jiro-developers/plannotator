import { SQL } from 'bun';
import type { RoomStore } from '../core/storage';
import type { RoomDoc, RoomListDoc } from '../core/types';

/**
 * Postgres store using Bun's built-in SQL client (zero extra dependencies).
 * Used automatically when DATABASE_URL is set — Railway's Postgres add-on
 * provides it out of the box.
 */
export class PostgresRoomStore implements RoomStore {
  private sql: SQL;
  private ready: Promise<void>;

  constructor(databaseUrl: string, ttlMs: number) {
    this.sql = new SQL(databaseUrl);
    this.ready = this.init(ttlMs);
  }

  private async init(ttlMs: number): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS plannotator_rooms (
        id TEXT PRIMARY KEY,
        doc JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    if (ttlMs > 0) {
      await this.sql`
        DELETE FROM plannotator_rooms
        WHERE updated_at < now() - make_interval(secs => ${ttlMs / 1000})
      `;
    }
  }

  async get(id: string): Promise<RoomDoc | null> {
    await this.ready;
    const rows = (await this.sql`
      SELECT doc FROM plannotator_rooms WHERE id = ${id}
    `) as Array<{ doc: RoomDoc }>;
    return rows.length > 0 ? rows[0].doc : null;
  }

  async list(): Promise<RoomListDoc[]> {
    await this.ready;
    // 본문·이력은 방마다 수 MB까지 커서 목록에서는 DB에서 빼고 받는다
    const rows = (await this.sql`
      SELECT doc - 'plan' - 'planHistory' AS doc
      FROM plannotator_rooms
      ORDER BY updated_at DESC
    `) as Array<{ doc: RoomListDoc }>;
    return rows.map((row) => row.doc);
  }

  async put(id: string, doc: RoomDoc): Promise<void> {
    await this.ready;
    // Bun.sql serializes a bound OBJECT to a jsonb object; binding a
    // pre-stringified payload double-encodes it into a jsonb string scalar.
    await this.sql`
      INSERT INTO plannotator_rooms (id, doc, updated_at)
      VALUES (${id}, ${doc}, now())
      ON CONFLICT (id) DO UPDATE SET doc = ${doc}, updated_at = now()
    `;
  }
}
