# Our Wedding Camera

A mobile-first digital disposable camera and **one shared wedding album** for Yani & Deni. Every invited guest has an individual 15-photo allowance. All accepted photos are stored in one Firebase project and shown together at `/gallery`.

## Stack

- Next.js App Router, React, TypeScript, responsive CSS
- Firebase Authentication for administrator sign-in
- Cloud Firestore for wedding settings, anonymous guest sessions, guest quotas, and photo metadata
- Firebase Storage for photo files
- Firebase Admin SDK for all trusted server operations
- Browser MediaDevices API for camera capture

## Firebase setup

1. Create a Firebase project and enable **Cloud Firestore**, **Cloud Storage**, and **Authentication → Email/Password**.
2. Create the initial administrator in Firebase Authentication. Put that account's email in `ADMIN_EMAILS`.
3. Create a service account key in Firebase Project settings → Service accounts. Store its full JSON in `FIREBASE_SERVICE_ACCOUNT_JSON` as a server-only environment variable. Never commit the service account file or expose it with a `NEXT_PUBLIC_` prefix.
4. Register a Firebase Web App and copy its API key, auth domain, project ID, app ID, and storage bucket name into `.env.local` using [`.env.example`](.env.example).
5. Create or use the project's default Storage bucket and set its exact name in both `FIREBASE_STORAGE_BUCKET` and `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` (typically `your-project.firebasestorage.app`).
6. Deploy the included Firestore indexes and deny-by-default rules with the Firebase CLI: `firebase deploy --only firestore:rules,firestore:indexes,storage`. The API uses the Admin SDK, so it is not blocked by client rules. Do not allow direct client writes to the collections or Storage bucket.
7. Run `npm install`, `npm run dev`, then open `http://localhost:3000`. Wedding settings are initialized on first API access. Guests can open the shared camera URL and enter a display name; no invitation code or guest account is required. Sign in at `/admin` to manage the shared album.

For deployment, set the same environment variables in Vercel (or another Node-compatible Next.js host). Use an HTTPS `NEXT_PUBLIC_SITE_URL`, because mobile camera access requires HTTPS.

## Environment variables

- `NEXT_PUBLIC_SITE_URL`: canonical HTTPS site URL, used by the admin QR code
- `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`: Firebase Web App configuration
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`: bucket name for the client app configuration
- `FIREBASE_STORAGE_BUCKET`: exact Storage bucket name used by the server
- `FIREBASE_SERVICE_ACCOUNT_JSON`: private service account JSON used by Firebase Admin SDK
- `ADMIN_EMAILS`: comma-separated allowlist of administrator email addresses
- `MAX_IMAGE_BYTES`: maximum upload size (default 3 MiB)

## Shared album and quota behavior

The `weddings/main` Firestore document holds the couple's shared settings. Guest profiles and all photos live in shared top-level collections; the gallery never filters by guest. It fetches 24 photos per page and refreshes the newest page every 12 seconds. Firestore compound indexes used by these queries are included in `firestore.indexes.json`.

Guests start an anonymous session by entering a display name. A random long-lived guest token is returned; only its hash is stored in Firestore. Each browser profile keeps its token locally and each guest document tracks `photos_used`. A Firestore transaction reserves a slot and photo record atomically, checking the 15-photo quota and reusing an idempotent pending or accepted upload on retry. Since guests do not sign in or use invitation codes, the quota is associated with that browser's guest session; clearing browser storage can create a new session. The server validates image type, decodes metadata, uploads the file to Storage, and marks its photo record accepted. Failed uploads release their pending slot. The Admin SDK verifies Firebase Auth ID tokens and checks the email allowlist for every admin API request.

Firebase Storage download-token URLs let the public shared gallery display photos without accounts, while Storage and Firestore client rules deny direct access. Admin operations can update wedding settings, delete individual photos, and stream all accepted photos into a ZIP. Do not use this public album for sensitive photos.

## Notes

- Firebase project credentials are not included in this repository. Configure a Firebase project and the environment variables before using data-backed features.
- Gallery updates use 12-second polling rather than Firestore realtime listeners.
- `gallery_visibility = link` means unlisted/share-link access; anyone with the URL can view the gallery.
- The client stores a compressed JPEG (up to about 3 MiB); the original phone image is not retained.
- Because guest access is open, share the camera and gallery URL with the intended guests. Configure Firebase backups, app/domain restrictions, billing alerts, and operational rate limiting before a large event.
- To run local checks, use `npm run typecheck` and `npm run build`. Camera permission behavior still needs a phone or camera-enabled browser.
