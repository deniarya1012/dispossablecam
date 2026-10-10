import { NextResponse } from 'next/server';
import { guestFromToken } from '@/lib/firebase';
export async function GET(request: Request) {
  try {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return NextResponse.json({ error: 'Start a guest session to continue.' }, { status: 401 });
    const guest = await guestFromToken(token);
    if (!guest) return NextResponse.json({ error: 'Guest session expired. Please enter your name to start a new session.' }, { status: 401 });
    return NextResponse.json({ guest: { id: guest.id, display_name: guest.display_name, photos_used: guest.photos_used, photo_limit: 15 } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load your guest account.' }, { status: 503 });
  }
}
