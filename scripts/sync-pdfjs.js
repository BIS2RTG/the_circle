/**
 * Copy the pdf.js browser builds into public/.
 *
 * Two different pdf.js copies run in this app, and each needs its worker served
 * from public/ at a version that matches its library EXACTLY — pdf.js refuses
 * to run against a mismatched worker:
 *
 *   1. The e-sign signature editor (components/esign/PdfSignatureEditor.tsx)
 *      cannot import pdfjs-dist through webpack — the ESM/CJS interop wrapper
 *      crashes and the editor hangs — so it loads the library at runtime from
 *      /public with a `webpackIgnore` dynamic import. It uses our top-level
 *      pdfjs-dist:  public/pdf.min.mjs + public/pdf.worker.min.mjs
 *
 *   2. The public invitation signer (components/esign/PublicPdfSigner.tsx) uses
 *      react-pdf, which bundles its OWN pinned pdfjs-dist. That version trails
 *      our top-level one, so it gets a separate worker file:
 *          public/pdf.worker.react-pdf.min.mjs
 *      Pointing it at the top-level worker above would pair a newer worker with
 *      react-pdf's older core and break the public signing page.
 *
 * These files used to be copied by hand, so they silently went stale: a
 * `npm audit fix` would bump pdfjs-dist in node_modules while the vulnerable
 * build stayed in public/ and kept being served to browsers. Running this on
 * postinstall keeps them in lockstep, so upgrading the dependency is enough to
 * upgrade what actually ships.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** Directory holding the pdf.js browser build for a given install of pdfjs-dist. */
function buildDirFor(fromPackage) {
  const paths = fromPackage
    ? [path.dirname(require.resolve(`${fromPackage}/package.json`))]
    : undefined;
  const pkgJson = require.resolve('pdfjs-dist/package.json', paths ? { paths } : undefined);
  return { dir: path.join(path.dirname(pkgJson), 'build'), version: require(pkgJson).version };
}

/** Copy one build file to public/, optionally under a different name. */
function copy(buildDir, file, destName) {
  const src = path.join(buildDir, file);
  if (!fs.existsSync(src)) {
    console.warn(`[sync-pdfjs] ${file} missing from ${buildDir} — skipping.`);
    return false;
  }
  fs.copyFileSync(src, path.join(PUBLIC_DIR, destName || file));
  return true;
}

function sync(label, fromPackage, files) {
  let build;
  try {
    build = buildDirFor(fromPackage);
  } catch {
    console.warn(`[sync-pdfjs] ${label}: pdfjs-dist not installed — skipping.`);
    return;
  }
  const copied = files.every(([file, destName]) => copy(build.dir, file, destName));
  if (copied) console.log(`[sync-pdfjs] ${label}: public/ updated to pdfjs-dist ${build.version}.`);
}

// 1. Top-level pdfjs-dist — the signature editor's library + worker.
sync('esign editor', null, [['pdf.min.mjs'], ['pdf.worker.min.mjs']]);

// 2. react-pdf's pinned pdfjs-dist — worker only; react-pdf bundles the library.
sync('react-pdf', 'react-pdf', [['pdf.worker.min.mjs', 'pdf.worker.react-pdf.min.mjs']]);
