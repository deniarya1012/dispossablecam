# Our Wedding Camera

A mobile-first wedding camera and **one shared album** for Yani & Deni. Every invited guest has an individual 15-photo allowance; all accepted uploads land in the same gallery at `/gallery`.

## Stack

- Next.js App Router, React, TypeScript, custom responsive CSS
- Supabase Postgres and Storage
- Supabase Auth for administrator sign-in
- Browser MediaDevices API for camera capture
- Server-side invitation redemption, upload validation, and quota transactions

## Run locally

1. Install Node.js 20 or newer.
2. Create a Supabase project and run [`supabase/migrations/202610100001_wedding_camera.sql`](supabase/migrations/202610100001_wedding_camera.sql) in the Supabase SQL editor (or with the Supabase CLI).
3. Copy `.env.example` to `.env.local` and fill in the Supabase project URL, public anon key, server-only service role key, and the administrator email allowlist. Keep `SUPABASE_SERVICE_ROLE_KEY` private; it must never be prefixed with `NEXT_PUBLIC_`.
4. In Supabase Auth, create the initial administrator user with email and password. Set `ADMIN_EMAILS` to that exact email. Admin routes also check the authenticated account on the server.
5. Run `npm install`, then `npm run dev` and open `http://localhost:3000`.
6. Sign in at `/admin`, create one-time invitation codes, and share one with each guest. The guest name is only a display name; the invitation code establishes the guest record and a random long-lived guest bearer token is stored server-side as a hash.

The migration creates the `wedding-photos` public read bucket, limits accepted images to 3 MiB, and prevents direct browser writes/deletes. Server routes use the service role for uploads and authorized admin actions. For a different bucket name, set `WEDDING_PHOTO_BUCKET` in the server environment and change the migration's bucket name to match.

## Deploy

Deploy the repository to Vercel (or another Node-compatible Next.js host), configure the environment variables from `.env.example`, and use the public HTTPS site URL as `NEXT_PUBLIC_SITE_URL`. The camera API requires HTTPS on phones. The administrator can copy the shared `/camera` URL or use the QR code in Admin → Sharing. The QR does not contain credentials.

Recommended production values:

- `NEXT_PUBLIC_SITE_URL`: canonical HTTPS domain
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Supabase project values
- `SUPABASE_SERVICE_ROLE_KEY`: server-side secret only
- `ADMIN_EMAILS`: comma-separated administrator emails
- `MAX_IMAGE_BYTES`: accepted upload size (default 3 MiB, keeping JSON photo submissions under common serverless request limits)
- `WEDDING_PHOTO_BUCKET`: `wedding-photos` unless the migration is adjusted

## Shared gallery and quota behavior

`/gallery` fetches accepted, visible photos across the wedding, without a guest filter. It loads in pages of 24 and refreshes every 12 seconds; each card opens a keyboard-operable lightbox. The album uses one wedding ID for every guest and photo. The gallery URL is common to all guests. Grid images request Supabase Storage transformations for thumbnail-sized delivery and fall back to the original image if transformations are unavailable; enable image transformations in Supabase for best performance.

Guest sessions require a one-time invitation code made in the admin dashboard. The browser retains the bearer token so a return visit on that browser resumes the same quota; only its SHA-256 hash is stored in Postgres. Invitation codes are single-use and stored only as hashes. The server validates image data and size. `reserve_photo_slot` locks the guest row, checks the current count, and inserts an idempotent pending photo row in the same transaction. A database trigger increments `photos_used`; the table check and row lock prevent concurrent requests from reserving more than 15. The server uploads to Storage and then marks the row accepted. On a failed upload it removes the pending reservation, returning that slot. Retrying with the same idempotency key reuses the reservation instead of consuming a second shot.

Admins can update wedding details, close submissions, configure guest-name display and downloads, search guests, create codes, download individual frames, and remove photos. Email allowlisting plus Supabase Auth is checked by the server for every admin API request. Storage objects are public-read to support a no-account shared album; guests cannot write or delete objects directly. Do not put sensitive photos in this wedding album.

## Configuration and known deployment dependencies

- No Supabase project credentials were present in this workspace, so database migrations, device camera permissions, photo persistence, admin authorization, QR behavior on the deployed domain, and gallery refresh could not be exercised against a live service here.
- Gallery refresh uses a 12-second polling interval rather than Supabase Realtime subscriptions.
- `gallery_visibility = link` is an unlisted/share-link setting. Anyone with the URL can view the gallery; the gallery does not require guest login.
- The client creates a compressed JPEG upload (up to about 3 MiB); the original phone image is not retained. The admin can stream all accepted originals into a ZIP, download individual photos, revoke unused invitation codes, and download the camera QR as SVG.
- Invitation codes are created one at a time and do not expire automatically. Configure Supabase project backups, domain restrictions, and operational rate limiting before a large public event. The one-time invitation code includes 60 random bits.

## Verification

Run `npm run typecheck` and `npm run build` for local verification. This empty project did not include an ESLint setup; Next's deprecated `next lint` command opens an interactive setup prompt, so no lint command is configured. `npm run test:integration` exercises invitation rejection, parallel submissions, per-guest quota, idempotent retry, shared gallery membership, persistence, and unauthenticated admin denial against a **dedicated test Supabase project** and a running app. It skips when `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are unavailable. Do not point this destructive test at production: it creates and removes test guests, codes, photos, and storage objects. Physical camera permission behavior still needs a phone or camera-enabled browser. The core quota guarantee is encoded in the migration's row-locking RPC, check constraint, idempotency uniqueness, and trigger.
