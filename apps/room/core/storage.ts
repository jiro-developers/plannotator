import type { RoomDoc } from './types';

export interface RoomStore {
  get(id: string): Promise<RoomDoc | null>;
  put(id: string, doc: RoomDoc): Promise<void>;
}
