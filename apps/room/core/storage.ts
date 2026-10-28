import type { RoomDoc, RoomListDoc } from './types';

export interface RoomStore {
  get(id: string): Promise<RoomDoc | null>;
  put(id: string, doc: RoomDoc): Promise<void>;
  /** All live rooms, most recently updated first. */
  list(): Promise<RoomListDoc[]>;
}
