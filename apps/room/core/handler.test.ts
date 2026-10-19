import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleRoomRequest } from './handler';
import { FsRoomStore } from '../stores/fs';

const store = new FsRoomStore(mkdtempSync(join(tmpdir(), 'room-test-')), 60_000);
const serveApp = async () => new Response('app');
const call = (path: string, init?: RequestInit) =>
  handleRoomRequest(new Request(`http://localhost${path}`, init), store, {}, { maxPlanSize: 100_000 }, serveApp);
const post = (path: string, body: unknown) =>
  call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

async function createRoom(): Promise<{ id: string; version: number }> {
  return (await post('/api/rooms', { plan: '# Plan\n\nbody', author: 'agent' })).json();
}

describe('GET /changes long-poll', () => {
  test('without wait, unchanged room answers 304 immediately', async () => {
    const { id, version } = await createRoom();
    expect((await call(`/api/rooms/${id}/changes?since=${version}`)).status).toBe(304);
  });

  test('returns as soon as a comment lands, not at the deadline', async () => {
    const { id, version } = await createRoom();
    const started = Date.now();
    const pending = call(`/api/rooms/${id}/changes?since=${version}&wait=10`);
    await Bun.sleep(100);
    await post(`/api/rooms/${id}/annotations`, {
      id: 'a1', type: 'COMMENT', originalText: 'body', text: 'hi', author: 'teammate',
    });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2_000);
    const snap = await res.json();
    expect(snap.version).toBeGreaterThan(version);
    expect(snap.annotations[0].text).toBe('hi');
  });

  test('times out with 304 after wait seconds', async () => {
    const { id, version } = await createRoom();
    const started = Date.now();
    const res = await call(`/api/rooms/${id}/changes?since=${version}&wait=1`);
    expect(res.status).toBe(304);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  test('client abort ends the wait', async () => {
    const { id, version } = await createRoom();
    const ac = new AbortController();
    const started = Date.now();
    const pending = call(`/api/rooms/${id}/changes?since=${version}&wait=10`, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    expect((await pending).status).toBe(304);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
