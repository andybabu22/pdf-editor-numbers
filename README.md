# Smart PDF Replacer — Local Only (Next.js)

**No AI, no server-side parsing**. All PDF processing happens in the browser:
- **Presentable (default)**: keeps the original heading exactly; cleans & reflows the remaining text; replaces all phone numbers.
- **Keep Layout**: overlays replacements in place while preserving the page layout.

### Deploy (GitHub + Vercel)
1. Upload this repo to GitHub.
2. Import into Vercel → Next.js will auto-detect.
3. Deploy. (No env vars needed.)

### Libraries
- `pdfjs-dist` (client) for text extraction and glyph positions
- `pdf-lib` for in-place overlays & for rebuilding PDFs
- `jszip` for batch download
- Tailwind for simple UI; Framer Motion for small animation

### Notes
- We set the PDF.js worker via CDN to avoid the "GlobalWorkerOptions.workerSrc" error.
- The `/api/fetch` route is a tiny proxy to bypass CORS when fetching third-party PDFs.
- If you see CORS blocks from certain hosts, try downloading the PDF to your own storage first.
