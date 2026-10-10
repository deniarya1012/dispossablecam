import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const DEFAULT_WEDDING = {
  couple_names: 'Yani & Deni',
  event_date: 'October 10, 2026',
  venue: 'Jakarta, Indonesia',
  welcome_message: 'Welcome to our wedding camera. Capture the little moments, the laughter, the happy tears, and everything in between. Your memories will become part of our shared wedding album.',
  event_status: 'open' as const,
  gallery_visibility: 'public' as const,
  photo_download_enabled: true,
  show_photographer: true,
};
export type WeddingSettings = typeof DEFAULT_WEDDING & { id: string; created_at?: string; updated_at?: string };

export function firebaseAdminApp() {
  const apps = getApps();
  if (apps.length) return apps[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Firebase is not configured. Add FIREBASE_SERVICE_ACCOUNT_JSON to the server environment.');
  const credentials = JSON.parse(raw);
  return initializeApp({ credential: cert(credentials), storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${credentials.project_id}.firebasestorage.app` });
}

export function adminDb() { return getFirestore(firebaseAdminApp()); }
export function adminStorage() { return getStorage(firebaseAdminApp()).bucket(process.env.FIREBASE_STORAGE_BUCKET); }

export async function getWedding(): Promise<WeddingSettings> {
  const ref = adminDb().collection('weddings').doc('main');
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return { id: snap.id, ...snap.data() } as WeddingSettings;
    tx.create(ref, { ...DEFAULT_WEDDING, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    return { id: ref.id, ...DEFAULT_WEDDING };
  });
}

export async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function requireAdmin(request: Request) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('Sign in as an administrator to continue.');
  const decoded = await getAuth(firebaseAdminApp()).verifyIdToken(token);
  const email = decoded.email?.toLowerCase();
  const allowlist = (process.env.ADMIN_EMAILS ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!email || !allowlist.includes(email)) throw new Error('This account is not authorized to manage the wedding album.');
  return { db: adminDb(), user: decoded };
}

export async function guestFromToken(token: string) {
  const tokenHash = await sha256(token);
  const snapshot = await adminDb().collection('guests').where('token_hash', '==', tokenHash).limit(1).get();
  if (snapshot.empty) return null;
  return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as FirebaseGuest;
}

export type FirebaseGuest = { id: string; display_name: string; photos_used: number; token_hash: string; created_at: string };
export function asDate(value: unknown) { return value instanceof Timestamp ? value.toDate() : value instanceof Date ? value : new Date(String(value)); }
export function publicPhotoUrl(path: string, token: string) {
  const bucket = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucket) throw new Error('Set FIREBASE_STORAGE_BUCKET to your Firebase Storage bucket name.');
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}
