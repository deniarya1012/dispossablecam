import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/supabase';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const { data, error } = await adminDb().from('weddings').select('*').limit(1).single();
    if (error) throw error;
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not load wedding settings.' }, { status: 503 });
  }
}
