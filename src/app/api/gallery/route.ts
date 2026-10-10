import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/supabase';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const db = adminDb();
    const url = new URL(request.url);
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('limit') || 24)));
    const [{ data: photos, error }, { count, error: countError }, { data: wedding }] = await Promise.all([
      db.from('photos').select('id,guest_id,storage_path,created_at,guests(display_name)').eq('upload_status', 'accepted').eq('moderation_status', 'visible').order('created_at', { ascending: false }).range(offset, offset + limit - 1),
      db.from('photos').select('id', { count: 'exact', head: true }).eq('upload_status', 'accepted').eq('moderation_status', 'visible'),
      db.from('weddings').select('photo_download_enabled,show_photographer').limit(1).single(),
    ]);
    if (error || countError) throw error || countError;
    const bucket = process.env.WEDDING_PHOTO_BUCKET || 'wedding-photos';
    const items = (photos || []).map((photo: any) => ({
      id: photo.id,
      photographer: wedding?.show_photographer === false ? null : photo.guests?.display_name || 'A wedding guest',
      created_at: photo.created_at,
      url: db.storage.from(bucket).getPublicUrl(photo.storage_path).data.publicUrl,
      thumbnail_url: db.storage.from(bucket).getPublicUrl(photo.storage_path, { transform: { width: 520, height: 680, resize: 'contain', quality: 76 } }).data.publicUrl,
      can_download: wedding?.photo_download_enabled !== false,
    }));
    return NextResponse.json({ photos: items, total: count || 0, hasMore: offset + items.length < (count || 0) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load the shared album.' }, { status: 503 });
  }
}
