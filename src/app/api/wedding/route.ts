import { NextResponse } from 'next/server';
import { getWedding } from '@/lib/firebase';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    return NextResponse.json(await getWedding());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load wedding settings.' }, { status: 503 });
  }
}
