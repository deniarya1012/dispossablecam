import { NextResponse } from 'next/server';
import { Readable, PassThrough } from 'node:stream';
import archiver from 'archiver';
import { requireAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db } = await requireAdmin(request);
    const { data: photos, error } = await db.from('photos').select('id,storage_path,created_at').eq('upload_status', 'accepted').order('created_at', { ascending: true });
    if (error) throw error;
    if (!photos?.length) return NextResponse.json({ error: 'There are no accepted photos to export yet.' }, { status: 404 });
    const bucket = process.env.WEDDING_PHOTO_BUCKET || 'wedding-photos';
    const archive = archiver('zip', { zlib: { level: 1 } });
    const output = new PassThrough();
    archive.on('error', (error) => output.destroy(error));
    archive.pipe(output);
    void (async () => {
      try {
        for (const [index, photo] of photos.entries()) {
          const { data, error: downloadError } = await db.storage.from(bucket).download(photo.storage_path);
          if (downloadError || !data) throw downloadError || new Error('A photo could not be downloaded from storage.');
          const extension = photo.storage_path.split('.').pop()?.replace(/[^a-z0-9]/gi, '') || 'jpg';
          archive.append(Buffer.from(await data.arrayBuffer()), { name: `${String(index + 1).padStart(4, '0')}_${photo.id}.${extension}` });
        }
        await archive.finalize();
      } catch (error) {
        archive.abort();
        output.destroy(error instanceof Error ? error : new Error('Album export failed.'));
      }
    })();
    return new Response(Readable.toWeb(output) as ReadableStream, {
      headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="yani-and-deni-wedding-album.zip"', 'cache-control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Album export failed.' }, { status: 401 });
  }
}
