import { NextResponse } from 'next/server';
import { z } from 'zod';
import sharp from 'sharp';
import { adminDb, sha256 } from '@/lib/supabase';
export const runtime = 'nodejs';
const schema = z.object({ dataUrl: z.string().min(100), idempotencyKey: z.string().uuid() });
export async function POST(request: Request) {
  let db: ReturnType<typeof adminDb> | undefined;
  let photoId: string | undefined;
  let path: string | undefined;
  let acceptedReservation = false;
  try {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return NextResponse.json({ error: 'Verify your invitation before uploading.' }, { status: 401 });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Choose a valid photo to upload.' }, { status: 400 });
    const match = parsed.data.dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return NextResponse.json({ error: 'Please upload a JPEG, PNG, or WebP photo.' }, { status: 415 });
    const buffer = Buffer.from(match[2], 'base64');
    // Keep serverless JSON requests below common platform payload limits; the camera compresses to this size too.
    const maxBytes = Number(process.env.MAX_IMAGE_BYTES || 3145728);
    if (buffer.length > maxBytes) return NextResponse.json({ error: `Photos must be smaller than ${Math.round(maxBytes / 1048576)} MB.` }, { status: 413 });
    const signatures: Record<string, boolean> = {
      'image/jpeg': buffer[0] === 0xff && buffer[1] === 0xd8,
      'image/png': buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      'image/webp': buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP',
    };
    if (!signatures[match[1]]) return NextResponse.json({ error: 'This file does not appear to be a supported image.' }, { status: 415 });
    const image = await sharp(buffer, { limitInputPixels: 40_000_000 }).metadata();
    if (!image.width || !image.height || !['jpeg', 'png', 'webp'].includes(image.format || '')) {
      return NextResponse.json({ error: 'This file is not a readable JPEG, PNG, or WebP image.' }, { status: 415 });
    }
    db = adminDb();
    const requestedId = crypto.randomUUID();
    const extension = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
    path = `shared/${crypto.randomUUID()}.${extension}`;
    const { data: reservation, error: reserveError } = await db.rpc('reserve_photo_slot', {
      p_token_hash: await sha256(token), p_photo_id: requestedId, p_idempotency_key: parsed.data.idempotencyKey, p_storage_path: path,
    });
    if (reserveError || !reservation) {
      const message = reserveError?.message || 'Unable to reserve a photo slot.';
      return NextResponse.json({ error: message.includes('PHOTO_LIMIT') ? 'You have used all 15 of your shots.' : message }, { status: message.includes('PHOTO_LIMIT') ? 409 : 403 });
    }
    const slot = Array.isArray(reservation) ? reservation[0] : reservation;
    const id = slot.photo_id;
    if (slot.upload_status === 'pending' && id !== requestedId) {
      return NextResponse.json({ error: 'This photo is already uploading. Give it a moment, then retry.' }, { status: 409 });
    }
    photoId = id;
    path = slot.storage_path as string;
    if (slot.upload_status === 'accepted') {
      acceptedReservation = true;
    const { data: guest } = await db.rpc('guest_from_token', { p_token_hash: await sha256(token) });
      const info = Array.isArray(guest) ? guest[0] : guest;
      if (!info) throw new Error('Guest session expired.');
      const bucket = process.env.WEDDING_PHOTO_BUCKET || 'wedding-photos';
      return NextResponse.json({ photo: { id, photographer: info.display_name, created_at: new Date().toISOString(), url: db.storage.from(bucket).getPublicUrl(path).data.publicUrl }, guest: { id: info.guest_id, display_name: info.display_name, photos_used: info.photos_used, photo_limit: 15 } });
    }
    const bucket = process.env.WEDDING_PHOTO_BUCKET || 'wedding-photos';
    const storagePath = slot.storage_path as string;
    const { error: storageError } = await db.storage.from(bucket).upload(storagePath, buffer, { contentType: match[1], upsert: false, cacheControl: '31536000' });
    if (storageError) throw storageError;
    const { data: accepted, error: acceptError } = await db.rpc('accept_photo_upload', { p_photo_id: id, p_token_hash: await sha256(token) });
    if (acceptError || !accepted) throw acceptError || new Error('The photo could not be confirmed. Please retry.');
    const { data: guest } = await db.rpc('guest_from_token', { p_token_hash: await sha256(token) });
    const info = Array.isArray(guest) ? guest[0] : guest;
    if (!info) throw new Error('Guest session expired.');
    return NextResponse.json({ photo: { id, photographer: info.display_name, created_at: new Date().toISOString(), url: db.storage.from(bucket).getPublicUrl(storagePath).data.publicUrl }, guest: { id: info.guest_id, display_name: info.display_name, photos_used: info.photos_used, photo_limit: 15 } });
  } catch (error) {
    if (db && photoId && !acceptedReservation) { try { await db.rpc('release_photo_slot', { p_photo_id: photoId }); } catch { /* Best-effort release after an upload failure. */ } }
    if (db && path && !acceptedReservation) { try { await db.storage.from(process.env.WEDDING_PHOTO_BUCKET || 'wedding-photos').remove([path]); } catch { /* Best-effort cleanup after an upload failure. */ } }
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Upload failed. Your shot was returned; please try again.' }, { status: 500 });
  }
}
