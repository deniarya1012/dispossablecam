import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, sha256 } from '@/lib/supabase';

export async function GET(request: Request) {
  try {
    const { db } = await requireAdmin(request);
    const [{ data: wedding }, { data: guests }, { data: photos }, { count: photoCount }, { count: usedUp }, { data: codes }] = await Promise.all([
      db.from('weddings').select('*').limit(1).single(),
      db.from('guests').select('id,display_name,photos_used,created_at').order('created_at', { ascending: false }),
      db.from('photos').select('id,storage_path,created_at,guest_id,guests(display_name)').eq('upload_status', 'accepted').order('created_at', { ascending: false }),
      db.from('photos').select('id', { count: 'exact', head: true }).eq('upload_status', 'accepted'),
      db.from('guests').select('id', { count: 'exact', head: true }).gte('photos_used', 15),
      db.from('invitation_codes').select('id,created_at,redeemed_at,is_active').order('created_at', { ascending: false }).limit(30),
    ]);
    const bucket = process.env.WEDDING_PHOTO_BUCKET || 'wedding-photos';
    return NextResponse.json({ wedding, guests: guests || [], codes: codes || [], photos: (photos || []).map((p: any) => ({ ...p, url: db.storage.from(bucket).getPublicUrl(p.storage_path).data.publicUrl })), stats: { guests: guests?.length || 0, photos: photoCount || 0, completed: usedUp || 0 } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load administrator data.' }, { status: 401 }); }
}

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('settings'), couple_names: z.string().min(1).max(100), event_date: z.string().max(100), venue: z.string().max(160), welcome_message: z.string().max(1200), event_status: z.enum(['open', 'closed']), gallery_visibility: z.enum(['public', 'link']), photo_download_enabled: z.boolean(), show_photographer: z.boolean() }),
  z.object({ action: z.literal('create_code') }),
  z.object({ action: z.literal('revoke_code'), codeId: z.string().uuid() }),
  z.object({ action: z.literal('delete_photo'), photoId: z.string().uuid() }),
]);
export async function POST(request: Request) {
  try {
    const { db } = await requireAdmin(request);
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Please check the submitted fields.' }, { status: 400 });
    if (parsed.data.action === 'settings') {
      const { action, ...fields } = parsed.data;
      const { data: wedding, error: lookupError } = await db.from('weddings').select('id').limit(1).single();
      if (lookupError || !wedding) throw lookupError || new Error('Wedding settings are missing.');
      const { error } = await db.from('weddings').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', wedding.id);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    if (parsed.data.action === 'create_code') {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(12))).map((n) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[n % 32]).join('').match(/.{1,4}/g)!.join('-');
      const { data: wedding, error: lookupError } = await db.from('weddings').select('id').limit(1).single();
      if (lookupError || !wedding) throw lookupError || new Error('Wedding settings are missing.');
      const { error } = await db.from('invitation_codes').insert({ wedding_id: wedding.id, code_hash: await sha256(code), is_active: true });
      if (error) throw error;
      return NextResponse.json({ code });
    }
    if (parsed.data.action === 'revoke_code') {
      const { error } = await db.from('invitation_codes').update({ is_active: false }).eq('id', parsed.data.codeId);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    const bucket = process.env.WEDDING_PHOTO_BUCKET || 'wedding-photos';
    const { data: photo, error: lookupError } = await db.from('photos').select('storage_path').eq('id', parsed.data.photoId).single();
    if (lookupError || !photo) throw lookupError || new Error('Photo not found.');
    const { error: storageError } = await db.storage.from(bucket).remove([photo.storage_path]);
    if (storageError) throw storageError;
    const { error } = await db.from('photos').delete().eq('id', parsed.data.photoId);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Administrator action failed.' }, { status: 401 }); }
}
