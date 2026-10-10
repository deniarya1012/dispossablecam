import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';

const baseUrl = process.env.TEST_APP_URL || 'http://localhost:3000';
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const enabled = Boolean(supabaseUrl && serviceKey);
const suite = enabled ? test : test.skip;
const db = enabled ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } }) : null;
const hash = (s) => createHash('sha256').update(s).digest('hex');

suite('shared album guest and quota flow', async (t) => {
  const runId = randomUUID();
  const codeA = `TESTA-${runId.slice(0, 8)}`;
  const codeB = `TESTB-${runId.slice(0, 8)}`;
  const jpeg = `data:image/jpeg;base64,${(await sharp({ create: { width: 2, height: 2, channels: 3, background: '#e8dfcc' } }).jpeg().toBuffer()).toString('base64')}`;
  const [{ data: wedding, error: weddingError }, { count: photosBefore }] = await Promise.all([
    db.from('weddings').select('id').limit(1).single(),
    db.from('photos').select('id', { count: 'exact', head: true }).eq('upload_status', 'accepted'),
  ]);
  assert.ifError(weddingError);
  const { error: codeError } = await db.from('invitation_codes').insert([
    { wedding_id: wedding.id, code_hash: hash(codeA), is_active: true },
    { wedding_id: wedding.id, code_hash: hash(codeB), is_active: true },
  ]);
  assert.ifError(codeError);
  let guestIds = [];
  try {
    const invalid = await fetch(`${baseUrl}/api/guest/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'No invitation', invitationCode: 'INVALID-INVITE' }) });
    assert.equal(invalid.status, 403, 'invalid invitation codes are rejected');
    const createGuest = async (displayName, invitationCode) => {
      const response = await fetch(`${baseUrl}/api/guest/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName, invitationCode }) });
      const body = await response.json(); assert.equal(response.status, 200, body.error); return body;
    };
    const guestA = await createGuest('Guest A', codeA);
    const guestB = await createGuest('Guest B', codeB);
    guestIds = [guestA.guest.id, guestB.guest.id];
    const submit = async (guest, idempotencyKey = randomUUID()) => {
      const response = await fetch(`${baseUrl}/api/guest/upload`, { method: 'POST', headers: { authorization: `Bearer ${guest.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl: jpeg, idempotencyKey }) });
      const result = await response.json(); return { response, result };
    };
    const concurrent = await Promise.all(Array.from({ length: 17 }, () => submit(guestA)));
    assert.equal(concurrent.filter((x) => x.response.status === 200).length, 15, 'parallel uploads cannot exceed 15 accepted slots');
    assert.ok(concurrent.some((x) => x.response.status === 409), 'uploads beyond the quota are rejected');
    const retryKey = randomUUID();
    const firstRetry = await submit(guestB, retryKey);
    assert.equal(firstRetry.response.status, 200, firstRetry.result.error);
    const duplicate = await submit(guestB, retryKey);
    assert.equal(duplicate.response.status, 200, duplicate.result.error);
    assert.equal(duplicate.result.photo.id, firstRetry.result.photo.id, 'retry returns the same accepted photo');
    assert.equal(duplicate.result.guest.photos_used, 1, 'retry does not consume another quota slot');
    const galleryResponse = await fetch(`${baseUrl}/api/gallery?offset=0&limit=60`);
    const gallery = await galleryResponse.json();
    assert.equal(galleryResponse.status, 200);
    assert.ok(gallery.photos.some((p) => p.photographer === 'Guest A'), 'shared gallery includes guest A');
    assert.ok(gallery.photos.some((p) => p.photographer === 'Guest B'), 'same gallery includes guest B');
    assert.equal(gallery.total, (photosBefore || 0) + 16, 'all accepted uploads share the same album total');
    const unauthorized = await fetch(`${baseUrl}/api/admin`);
    assert.equal(unauthorized.status, 401, 'admin data is not available without an authenticated admin token');
    const persisted = await fetch(`${baseUrl}/api/guest/me`, { headers: { authorization: `Bearer ${guestA.token}` } });
    assert.equal((await persisted.json()).guest.photos_used, 15, 'server retains the quota after a new session lookup');
  } finally {
    const { data: paths } = await db.from('photos').select('storage_path').in('guest_id', guestIds);
    if (paths?.length) await db.storage.from(process.env.WEDDING_PHOTO_BUCKET || 'wedding-photos').remove(paths.map((x) => x.storage_path));
    if (guestIds.length) await db.from('guests').delete().in('id', guestIds);
    await db.from('invitation_codes').delete().eq('wedding_id', wedding.id).in('code_hash', [hash(codeA), hash(codeB)]);
  }
});

if (!enabled) console.info('Integration test skipped: configure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for a dedicated test project.');
