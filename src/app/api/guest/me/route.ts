import { NextResponse } from 'next/server';
import { adminDb, sha256 } from '@/lib/supabase';
export async function GET(request: Request) {
  try {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return NextResponse.json({ error: 'Enter your invitation code to continue.' }, { status: 401 });
    const { data, error } = await adminDb().rpc('guest_from_token', { p_token_hash: await sha256(token) });
    if (error || !data) return NextResponse.json({ error: 'Guest session expired. Please use your invitation code again.' }, { status: 401 });
    const guest = Array.isArray(data) ? data[0] : data;
    return NextResponse.json({ guest: { id: guest.guest_id, display_name: guest.display_name, photos_used: guest.photos_used, photo_limit: 15 } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load your guest account.' }, { status: 503 });
  }
}
