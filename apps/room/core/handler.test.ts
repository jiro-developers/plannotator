import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleRoomRequest } from './handler';
import { FsRoomStore } from '../stores/fs';
import { createSessionCookie } from './auth';

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

describe('POST /annotations planVersion', () => {
  const put = (path: string, body: unknown) =>
    call(path, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  const comment = (id: string, planVersion?: unknown) => ({
    id, type: 'COMMENT', originalText: 'body', text: 'hi', author: 'teammate', planVersion,
  });

  test('keeps the older plan version the author was looking at', async () => {
    const { id } = await createRoom();
    await put(`/api/rooms/${id}/plan`, { plan: '# Plan\n\nbody v2', author: 'agent' });
    const { annotation } = await (await post(`/api/rooms/${id}/annotations`, comment('a1', 1))).json();
    expect(annotation.planVersion).toBe(1);
  });

  test('falls back to the current plan version when missing or out of range', async () => {
    const { id } = await createRoom();
    const missing = await (await post(`/api/rooms/${id}/annotations`, comment('a1'))).json();
    const ahead = await (await post(`/api/rooms/${id}/annotations`, comment('a2', 99))).json();
    const fractional = await (await post(`/api/rooms/${id}/annotations`, comment('a3', 0.5))).json();
    expect(missing.annotation.planVersion).toBe(1);
    expect(ahead.annotation.planVersion).toBe(1);
    expect(fractional.annotation.planVersion).toBe(1);
  });
});

describe('GET /api/rooms list', () => {
  const auth = {
    googleClientId: 'id',
    googleClientSecret: 'secret',
    sessionSecret: 'test-session-secret',
    allowedDomain: 'example.com',
    agentToken: 'agent-token',
  };
  const listStore = new FsRoomStore(mkdtempSync(join(tmpdir(), 'room-list-')), 60_000);
  const authed = async (path: string, user: { email: string; name: string } | 'agent', init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (user === 'agent') headers.set('Authorization', 'Bearer agent-token');
    else headers.set('Cookie', (await createSessionCookie(user, auth.sessionSecret)).split(';')[0]);
    return handleRoomRequest(
      new Request(`http://localhost${path}`, { ...init, headers }),
      listStore,
      {},
      { maxPlanSize: 100_000, auth },
      serveApp
    );
  };
  const kim = { email: 'kim@example.com', name: '김' };
  const lee = { email: 'lee@example.com', name: '이' };
  const send = (path: string, user: typeof kim | 'agent', method: string, body: unknown) =>
    authed(path, user, { method, body: JSON.stringify(body) });

  test('lists newest first without plan bodies, judging participation per caller', async () => {
    const older = await (await send('/api/rooms', 'agent', 'POST', { plan: '# Older\n\nbody' })).json();
    const newer = await (await send('/api/rooms', 'agent', 'POST', { plan: '# Newer\n\nbody' })).json();
    await send(`/api/rooms/${older.id}/annotations`, kim, 'POST', {
      id: 'k1', type: 'COMMENT', originalText: 'body', text: 'hi', author: 'ignored',
    });
    await send(`/api/rooms/${newer.id}/acks`, lee, 'POST', {});

    const listFor = async (user: typeof kim | 'agent') => (await (await authed('/api/rooms', user)).json()).rooms;
    const forKim = await listFor(kim);
    expect(forKim.map((r: { title: string }) => r.title)).toEqual(['Newer', 'Older']);
    expect(forKim[0].plan).toBeUndefined();
    expect(forKim.find((r: { id: string }) => r.id === older.id)).toMatchObject({
      participated: true, annotationCount: 1, openCount: 1,
    });
    expect(forKim.find((r: { id: string }) => r.id === newer.id).participated).toBe(false);

    const forLee = await listFor(lee);
    expect(forLee.find((r: { id: string }) => r.id === newer.id)).toMatchObject({ participated: true, ackCount: 1 });
    expect((await listFor('agent')).every((r: { participated: boolean }) => !r.participated)).toBe(true);
  });

  test('participation survives a display-name change and stays out of snapshots', async () => {
    const room = await (await send('/api/rooms', 'agent', 'POST', { plan: '# Rename\n\nbody' })).json();
    await send(`/api/rooms/${room.id}/annotations`, kim, 'POST', {
      id: 'r1', type: 'COMMENT', originalText: 'body', text: 'hi', author: 'ignored',
    });
    const renamed = { email: kim.email, name: '김새이름' };
    const rooms = (await (await authed('/api/rooms', renamed)).json()).rooms;
    expect(rooms.find((r: { id: string }) => r.id === room.id).participated).toBe(true);
    const snapshot = await (await authed(`/api/rooms/${room.id}`, kim)).json();
    expect(snapshot.participants).toBeUndefined();
  });
});
