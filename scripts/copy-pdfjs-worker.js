// scripts/copy-pdfjs-worker.js
// Copies worker files from node_modules to /public so we can load them from same-origin.
const fs = require('fs');
const path = require('path');

const srcDir = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'build');
const publicDir = path.join(process.cwd(), 'public');

const files = ['pdf.worker.min.js', 'pdf.worker.min.mjs'];

for (const name of files) {
  const src = path.join(srcDir, name);
  const dst = path.join(publicDir, name);
  try {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      console.log('Copied', name, '->', path.relative(process.cwd(), dst));
    } else {
      console.warn('Not found:', src);
    }
  } catch (e) {
    console.error('Failed to copy', name, e);
    process.exitCode = 0; // don't fail install if one variant is missing
  }
}
