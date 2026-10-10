import { NextResponse } from 'next/server';
import { Readable, PassThrough } from 'node:stream';
import archiver from 'archiver';
import { adminDb, adminStorage, requireAdmin } from '@/lib/firebase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db } = await requireAdmin(request);
    const photos = await db.collection('photos').where('upload_status', '==', 'accepted').orderBy('created_at', 'asc').get();
    if (photos.empty) return NextResponse.json({ error: 'There are no accepted photos to export yet.' }, { status: 404 });
    const archive = archiver('zip', { zlib: { level: 1 } });
    const output = new PassThrough();
    archive.on('error', (error) => output.destroy(error));
    archive.pipe(output);
    void (async () => {
      try {
        for (const [index, doc] of photos.docs.entries()) {
          const photo = doc.data();
          const [buffer] = await adminStorage().file(photo.storage_path).download();
          const extension = photo.storage_path.split('.').pop()?.replace(/[^a-z0-9]/gi, '') || 'jpg';
          archive.append(buffer, { name: `${String(index + 1).padStart(4, '0')}_${doc.id}.${extension}` });
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
