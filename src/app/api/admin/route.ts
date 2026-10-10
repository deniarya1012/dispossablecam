import { NextResponse } from 'next/server';
import { z } from 'zod';
import { adminDb, adminStorage, getWedding, publicPhotoUrl, requireAdmin } from '@/lib/firebase';

export async function GET(request: Request) {
  try {
    const { db } = await requireAdmin(request);
    const [wedding, guestDocs, photoDocs] = await Promise.all([
      getWedding(),
      db.collection('guests').orderBy('created_at', 'desc').get(),
      db.collection('photos').where('upload_status', '==', 'accepted').orderBy('created_at', 'desc').get(),
    ]);
    const guests = guestDocs.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const guestNames = new Map(guests.map((guest: any) => [guest.id, guest.display_name]));
    const photos = photoDocs.docs.map((doc) => {
      const photo = doc.data();
      return { id: doc.id, ...photo, guests: { display_name: guestNames.get(photo.guest_id) || 'A wedding guest' }, url: publicPhotoUrl(photo.storage_path, photo.download_token) };
    });
    const completed = guests.filter((guest: any) => guest.photos_used >= 15).length;
    return NextResponse.json({ wedding, guests, photos, stats: { guests: guests.length, photos: photos.length, completed } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load administrator data.' }, { status: 401 }); }
}

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('settings'), couple_names: z.string().min(1).max(100), event_date: z.string().max(100), venue: z.string().max(160), welcome_message: z.string().max(1200), event_status: z.enum(['open', 'closed']), gallery_visibility: z.enum(['public', 'link']), photo_download_enabled: z.boolean(), show_photographer: z.boolean() }),
  z.object({ action: z.literal('delete_photo'), photoId: z.string().min(1).max(128) }),
]);

export async function POST(request: Request) {
  try {
    const { db } = await requireAdmin(request);
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Please check the submitted fields.' }, { status: 400 });
    if (parsed.data.action === 'settings') {
      const { action, ...fields } = parsed.data;
      await db.collection('weddings').doc('main').set({ ...fields, updated_at: new Date().toISOString() }, { merge: true });
      return NextResponse.json({ ok: true });
    }
    const photoRef = db.collection('photos').doc(parsed.data.photoId);
    const photo = await photoRef.get();
    if (!photo.exists) throw new Error('Photo not found.');
    await adminStorage().file(photo.data()!.storage_path).delete({ ignoreNotFound: true });
    await db.runTransaction(async (tx) => {
      const [photoSnapshot, guestSnapshot] = await Promise.all([
        tx.get(photoRef), tx.get(db.collection('guests').doc(photo.data()!.guest_id)),
      ]);
      if (!photoSnapshot.exists) return;
      tx.delete(photoRef);
      if (guestSnapshot.exists) tx.update(guestSnapshot.ref, { photos_used: Math.max(0, Number(guestSnapshot.data()?.photos_used || 0) - 1) });
    });
    return NextResponse.json({ ok: true });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Administrator action failed.' }, { status: 401 }); }
}
