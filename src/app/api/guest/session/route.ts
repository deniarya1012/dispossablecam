import { NextResponse } from 'next/server';
import { z } from 'zod';
import { adminDb, getWedding, sha256 } from '@/lib/firebase';
const bodySchema = z.object({ displayName: z.string().trim().min(1).max(60) });
export async function POST(request: Request) {
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Enter your name to join the shared album.' }, { status: 400 });
    const bearer = crypto.randomUUID() + crypto.randomUUID();
    const db = adminDb();
    const wedding = await getWedding();
    if (wedding.event_status !== 'open') return NextResponse.json({ error: 'Photo submissions are closed for now.' }, { status: 403 });
    const guestRef = db.collection('guests').doc(crypto.randomUUID());
    const guest = { id: guestRef.id, wedding_id: 'main', display_name: parsed.data.displayName, photos_used: 0, token_hash: await sha256(bearer), created_at: new Date().toISOString() };
    await guestRef.create({ wedding_id: guest.wedding_id, display_name: guest.display_name, photos_used: guest.photos_used, token_hash: guest.token_hash, created_at: guest.created_at });
    return NextResponse.json({ token: bearer, guest: { id: guest.id, display_name: guest.display_name, photos_used: guest.photos_used, photo_limit: 15 } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not start your guest session.' }, { status: 503 });
  }
}
