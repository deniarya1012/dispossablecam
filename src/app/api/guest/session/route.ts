import { NextResponse } from 'next/server';
import { z } from 'zod';
import { adminDb, sha256 } from '@/lib/supabase';
const bodySchema = z.object({ displayName: z.string().trim().min(1).max(60), invitationCode: z.string().trim().min(4).max(100) });
export async function POST(request: Request) {
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Enter your name and invitation code.' }, { status: 400 });
    const bearer = crypto.randomUUID() + crypto.randomUUID();
    const { data, error } = await adminDb().rpc('redeem_invitation', {
      p_code_hash: await sha256(parsed.data.invitationCode.toUpperCase()),
      p_display_name: parsed.data.displayName,
      p_token_hash: await sha256(bearer),
    });
    if (error || !data) return NextResponse.json({ error: 'That invitation code is invalid, expired, or already used. Please check with Yani & Deni.' }, { status: 403 });
    const guest = Array.isArray(data) ? data[0] : data;
    return NextResponse.json({ token: bearer, guest: { id: guest.guest_id, display_name: guest.display_name, photos_used: guest.photos_used, photo_limit: 15 } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not verify your invitation.' }, { status: 503 });
  }
}
