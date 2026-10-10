import { createClient } from '@supabase/supabase-js';

export function adminDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase is not configured. Add the project URL and service role key to the server environment.');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export function publicDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

export async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function requireAdmin(request: Request) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('Sign in as an administrator to continue.');
  const db = adminDb();
  const { data: { user }, error } = await db.auth.getUser(token);
  if (error || !user?.email) throw new Error('Your administrator session has expired. Please sign in again.');
  const allowlist = (process.env.ADMIN_EMAILS ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (!allowlist.includes(user.email.toLowerCase())) throw new Error('This account is not authorized to manage the wedding album.');
  return { db, user };
}
