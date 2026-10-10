import { NextResponse } from 'next/server';
import { z } from 'zod';
import sharp from 'sharp';
import { adminDb, adminStorage, getWedding, guestFromToken, publicPhotoUrl, sha256 } from '@/lib/firebase';

export const runtime = 'nodejs';
const schema = z.object({ dataUrl: z.string().min(100), idempotencyKey: z.string().uuid() });
const PHOTO_LIMIT = 15;

export async function POST(request: Request) {
  let photoId: string | undefined;
  let storagePath: string | undefined;
  let guestId: string | undefined;
  let accepted = false;
  try {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return NextResponse.json({ error: 'Start a guest session before uploading.' }, { status: 401 });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Choose a valid photo to upload.' }, { status: 400 });
    const match = parsed.data.dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return NextResponse.json({ error: 'Please upload a JPEG, PNG, or WebP photo.' }, { status: 415 });
    const buffer = Buffer.from(match[2], 'base64');
    const maxBytes = Number(process.env.MAX_IMAGE_BYTES || 3145728);
    if (buffer.length > maxBytes) return NextResponse.json({ error: `Photos must be smaller than ${Math.round(maxBytes / 1048576)} MB.` }, { status: 413 });
    const signatures: Record<string, boolean> = {
      'image/jpeg': buffer[0] === 0xff && buffer[1] === 0xd8,
      'image/png': buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      'image/webp': buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP',
    };
    if (!signatures[match[1]]) return NextResponse.json({ error: 'This file does not appear to be a supported image.' }, { status: 415 });
    const image = await sharp(buffer, { limitInputPixels: 40_000_000 }).metadata();
    if (!image.width || !image.height || !['jpeg', 'png', 'webp'].includes(image.format || '')) return NextResponse.json({ error: 'This file is not a readable JPEG, PNG, or WebP image.' }, { status: 415 });

    const wedding = await getWedding();
    if (wedding.event_status !== 'open') return NextResponse.json({ error: 'Photo submissions are closed for now.' }, { status: 403 });
    const guest = await guestFromToken(token);
    if (!guest) return NextResponse.json({ error: 'Guest session expired. Please enter your name to start a new session.' }, { status: 401 });
    guestId = guest.id;
    const db = adminDb();
    const guestRef = db.collection('guests').doc(guest.id);
    const requestedId = crypto.randomUUID();
    const extension = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
    const requestedPath = `shared/${crypto.randomUUID()}.${extension}`;
    const reserve = await db.runTransaction(async (tx) => {
      const guestSnap = await tx.get(guestRef);
      const existing = await tx.get(db.collection('photos').where('guest_id', '==', guest.id).where('idempotency_key', '==', parsed.data.idempotencyKey).limit(1));
      if (!guestSnap.exists) throw new Error('Guest session expired.');
      let reclaimedPending = false;
      if (!existing.empty) {
        const doc = existing.docs[0];
        const data = doc.data();
        if (data.upload_status === 'accepted') return { id: doc.id, path: data.storage_path, status: 'accepted' as const };
        const createdAt = new Date(data.created_at).getTime();
        if (Date.now() - createdAt < 15 * 60 * 1000) return { id: doc.id, path: data.storage_path, status: 'pending' as const };
        tx.delete(doc.ref);
        reclaimedPending = true;
      }
      const current = Number(guestSnap.data()?.photos_used || 0);
      if (!reclaimedPending && current >= PHOTO_LIMIT) throw new Error('PHOTO_LIMIT');
      const photoRef = db.collection('photos').doc(requestedId);
      tx.update(guestRef, { photos_used: reclaimedPending ? current : current + 1 });
      tx.create(photoRef, { wedding_id: 'main', guest_id: guest.id, idempotency_key: parsed.data.idempotencyKey, storage_path: requestedPath, created_at: new Date().toISOString(), upload_status: 'pending', moderation_status: 'visible' });
      return { id: requestedId, path: requestedPath, status: 'pending' as const };
    });
    photoId = reserve.id;
    storagePath = reserve.path;
    const resolvedPhotoId = reserve.id;
    const resolvedStoragePath = reserve.path;
    if (reserve.status === 'pending' && reserve.id !== requestedId) return NextResponse.json({ error: 'This photo is already uploading. Give it a moment, then retry.' }, { status: 409 });
    if (reserve.status === 'accepted') accepted = true;

    const bucket = adminStorage();
    const file = bucket.file(resolvedStoragePath);
    let downloadToken: string;
    if (accepted) {
      const [metadata] = await file.getMetadata();
      downloadToken = String(metadata.metadata?.firebaseStorageDownloadTokens || '');
      if (!downloadToken) throw new Error('The saved photo is missing its download link.');
    } else {
      downloadToken = crypto.randomUUID();
      await file.save(buffer, { resumable: false, validation: 'md5', metadata: { contentType: match[1], cacheControl: 'public,max-age=31536000,immutable', metadata: { firebaseStorageDownloadTokens: downloadToken } } });
      await db.collection('photos').doc(resolvedPhotoId).update({ upload_status: 'accepted', download_token: downloadToken, accepted_at: new Date().toISOString() });
      accepted = true;
    }
    const latestGuest = await guestFromToken(token);
    if (!latestGuest) throw new Error('Guest session expired.');
    return NextResponse.json({ photo: { id: resolvedPhotoId, photographer: latestGuest.display_name, created_at: new Date().toISOString(), url: publicPhotoUrl(resolvedStoragePath, downloadToken) }, guest: { id: latestGuest.id, display_name: latestGuest.display_name, photos_used: latestGuest.photos_used, photo_limit: PHOTO_LIMIT } });
  } catch (error) {
    if (error instanceof Error && error.message === 'PHOTO_LIMIT') return NextResponse.json({ error: 'You have used all 15 of your shots.' }, { status: 409 });
    if (photoId && guestId && !accepted) {
      try {
        const db = adminDb();
        await db.runTransaction(async (tx) => {
          const photoRef = db.collection('photos').doc(photoId!);
          const guestRef = db.collection('guests').doc(guestId!);
          const [photoSnap, guestSnap] = await Promise.all([tx.get(photoRef), tx.get(guestRef)]);
          if (photoSnap.exists && photoSnap.data()?.upload_status === 'pending') {
            tx.delete(photoRef);
            if (guestSnap.exists) tx.update(guestRef, { photos_used: Math.max(0, Number(guestSnap.data()?.photos_used || 0) - 1) });
          }
        });
      } catch { /* Best-effort release after a failed upload. */ }
      if (storagePath) { try { await adminStorage().file(storagePath).delete({ ignoreNotFound: true }); } catch { /* Best-effort storage cleanup. */ } }
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Upload failed. Your shot was returned; please try again.' }, { status: 500 });
  }
}
