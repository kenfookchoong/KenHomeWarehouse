# Ken's Home Warehouse

Home inventory organised like a warehouse: rooms → furniture → drawers/boxes, each with a label code
(`A-01-02`), plus search, duplicate prevention, photos, find-by-picture and expiry dates.

## Two versions, one source

| | Where | Storage | Photo reading |
|---|---|---|---|
| `index.html` | claude.ai artifact | Claude (synced, needs sign-in) | Claude (not on phones yet) |
| `docs/` | GitHub Pages | This device (IndexedDB), optional free cloud sync (Supabase) | Free, on-device (Tesseract + MobileNet) |

Edit `index.html`, then run `python3 tools/build_docs.py` to regenerate `docs/index.html`.
`docs/local.js` provides the on-device storage and photo reader; `docs/vendor/` holds the bundled libraries.

## Cloud sync (self-hosted version, optional)

The self-hosted app keeps working on-device; signing in adds free online backup and sync between devices.
1. Create a free project at supabase.com.
2. SQL Editor → paste `docs/supabase-setup.sql` → Run.
3. Put the Project URL and anon public key in `docs/cloud-config.js` (or enter them in the app: Clean-up → Cloud sync).
4. In the app: Clean-up → Cloud sync → Create account (or create the user under Authentication → Users with auto-confirm).

The first sign-in on a device uploads what is already on it; after that, changes sync every 30 seconds,
when the app is reopened, and when the connection comes back. The newest edit wins.

## Moving data between versions

Clean-up tab → **Download backup** in one version, then **Restore from backup** in the other.
Backups include photos.

## Third-party
- [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0) and English traineddata (Apache-2.0)
- [TensorFlow.js](https://github.com/tensorflow/tfjs) and MobileNet v1 0.50 weights (Apache-2.0)
