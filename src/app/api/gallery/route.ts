import { NextResponse } from 'next/server';
import { adminDb, getWedding, publicPhotoUrl } from '@/lib/firebase';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const db = adminDb();
    const url = new URL(request.url);
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('limit') || 24)));
    const [{ docs }, countSnapshot, wedding] = await Promise.all([
      db.collection('photos').where('upload_status', '==', 'accepted').where('moderation_status', '==', 'visible').orderBy('created_at', 'desc').offset(offset).limit(limit).get(),
      db.collection('photos').where('upload_status', '==', 'accepted').where('moderation_status', '==', 'visible').count().get(),
      getWedding(),
    ]);
    const guestIds = [...new Set(docs.map((photo) => photo.data().guest_id as string))];
    const guestSnapshots = await Promise.all(guestIds.map((id) => db.collection('guests').doc(id).get()));
    const guests = new Map(guestSnapshots.map((guest) => [guest.id, guest.data()?.display_name || 'A wedding guest']));
    const photos = docs.map((doc) => {
      const photo = doc.data();
      const token = photo.download_token;
      return {
        id: doc.id,
        photographer: wedding.show_photographer === false ? null : guests.get(photo.guest_id) || 'A wedding guest',
        created_at: photo.accepted_at || photo.created_at,
        url: publicPhotoUrl(photo.storage_path, token),
        can_download: wedding.photo_download_enabled !== false,
      };
    });
    const total = countSnapshot.data().count;
    return NextResponse.json({ photos, total, hasMore: offset + photos.length < total });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load the shared album.' }, { status: 503 });
  }
}
