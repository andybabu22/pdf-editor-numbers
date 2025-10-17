# Smart PDF Replacer — Local Only (V3)

**One-time fix for PDF.js worker error**.

## Why you saw this
PDF.js >= 4 uses an ES module worker. Loading it from a CDN (`unpkg`) can fail in production (Vercel) with:
> Setting up fake worker failed: Failed to fetch dynamically imported module...

## This version fixes it
- Uses the **legacy build**: `pdfjs-dist/legacy/build/pdf` (compatible with classic worker).
- Copies worker files into **/public** at install time:
  - `scripts/copy-pdfjs-worker.js` (runs in `postinstall`)
  - Sets `GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js"`
- No AI, no server parsing. All PDF work is client-side.

## Deploy
1. Push to GitHub.
2. Import into Vercel.
3. Deploy. (The `postinstall` will copy the worker into `/public` automatically.)

If you still get a build using cached artifacts, use **Redeploy → Clear build cache** on Vercel.
