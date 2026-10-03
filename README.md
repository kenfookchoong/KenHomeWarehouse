# Ken's Home Warehouse

Home inventory organised like a warehouse: rooms → furniture → drawers/boxes, each with a label code
(`A-01-02`), plus search, duplicate prevention, photos, find-by-picture and expiry dates.

## Two versions, one source

| | Where | Storage | Photo reading |
|---|---|---|---|
| `index.html` | claude.ai artifact | Claude (synced, needs sign-in) | Claude (not on phones yet) |
| `docs/` | GitHub Pages | This device (IndexedDB) | Free, on-device (Tesseract + MobileNet) |

Edit `index.html`, then run `python3 tools/build_docs.py` to regenerate `docs/index.html`.
`docs/local.js` provides the on-device storage and photo reader; `docs/vendor/` holds the bundled libraries.

## Moving data between versions

Clean-up tab → **Download backup** in one version, then **Restore from backup** in the other.
Backups include photos.

## Third-party
- [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0) and English traineddata (Apache-2.0)
- [TensorFlow.js](https://github.com/tensorflow/tfjs) and MobileNet v1 0.50 weights (Apache-2.0)
