// pages/index.js
import { useState } from "react";
import { motion } from "framer-motion";
import JSZip from "jszip";

// Unicode font (handles ™ ® ℗ bullets etc.)
const FONT_URL =
  "https://raw.githubusercontent.com/GreatWizard/notosans-fontface/master/fonts/NotoSans-Regular.ttf";

// Robust phone detector
const PHONE_RE = /(\+?\d[\d\s\-()./\\|•·–—_⇄⇋]{7,}\d)/g;

// Vanity 1-800-FLOWERS -> digits
const VANITY_MAP = {A:"2",B:"2",C:"2",D:"3",E:"3",F:"3",G:"4",H:"4",I:"4",J:"5",K:"5",L:"5",M:"6",N:"6",O:"6",P:"7",Q:"7",R:"7",S:"7",T:"8",U:"8",V:"8",W:"9",X:"9",Y:"9",Z:"9"};
function convertVanityToDigits(s) {
  return s.replace(
    /\b(1[\s\-]?(?:8(?:00|33|44|55|66|77|88))[\s\-]?)([A-Za-z][A-Za-z\-]{3,})\b/gi,
    (_, prefix, word) => {
      const digits = word.replace(/[^A-Za-z]/g, "").toUpperCase().split("").map(ch => VANITY_MAP[ch] || "").join("");
      return prefix + (digits || word);
    }
  );
}

// Normalize odd separators
function normalizeWeird(text) {
  return text
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "") // zero-width + soft hyphen
    .replace(/[⇄⇋•·–—_]+/g, "-")                 // unify odd separators
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---- PDF.js helpers (client) ----
async function loadPdfJs() {
  const pdfjsMod = await import("pdfjs-dist");
  const pdfjs = pdfjsMod.default?.getDocument ? pdfjsMod.default : pdfjsMod;
  const version = pdfjs.version || pdfjsMod.version || "4.7.76";
  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.mjs`;
  }
  return pdfjs;
}

async function extractTextAllPages(srcBytes) {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: srcBytes, disableWorker: true });
  const doc = await task.promise;
  let lines = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent({ disableCombineTextItems: false });
    const pageLines = [];
    let currentY = null;
    let line = [];
    for (const it of content.items) {
      const [, , , , e, f] = it.transform;
      const x = e, y = f;
      if (currentY === null || Math.abs(currentY - y) > 2.0) {
        if (line.length) pageLines.push(line);
        line = [{ str: it.str, x }];
        currentY = y;
      } else {
        line.push({ str: it.str, x });
      }
    }
    if (line.length) pageLines.push(line);
    const pageTextLines = pageLines.map(arr => arr.sort((a,b)=>a.x-b.x).map(t=>t.str).join(""));
    lines = lines.concat(pageTextLines);
  }
  return lines.join("\n");
}

// ---- Utilities ----
const bytesToDataUrl = (mime, bytes) => {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  return `data:${mime};base64,${base64}`;
};

// Stricter bullet detector (dash+space OR leading bullet glyph)
// Avoids treating phone numbers (1-888…) as bullets.
function isBulletLine(line) {
  return /^([•·*]\s+|-\s+)/.test(line);
}

// Pick a clean heading candidate (never a giant “paragraph” line)
function chooseHeading(rawLines) {
  const candidates = rawLines.slice(0, 25).map(s => s.trim()).filter(Boolean);
  for (const s of candidates) {
    const letters = (s.match(/[A-Za-z]/g) || []).length;
    const digits  = (s.match(/\d/g) || []).length;
    const len = s.length;
    if (len >= 8 && len <= 120 && letters > digits * 2) return s;
  }
  // Fall back: split first non-empty line at obvious separators
  const first = candidates[0] || "Document";
  const parts = first.split(/\s[-–—:|]\s| - | — | : /).filter(Boolean);
  return (parts[0] || first).slice(0, 140);
}

// ---- UI ----
export default function Home() {
  const [pdfUrls, setPdfUrls] = useState("");
  const [replaceNumber, setReplaceNumber] = useState("");

  const [layoutMode, setLayoutMode] = useState("presentable"); // 'presentable' | 'inplace'
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");

  const [progressTotal, setProgressTotal] = useState(0);
  const [progressDone, setProgressDone] = useState(0);
  const percent = progressTotal ? Math.round((progressDone / progressTotal) * 100) : 0;

  const [openPreview, setOpenPreview] = useState({});
  const togglePreview = (idx) => setOpenPreview(p => ({ ...p, [idx]: !p[idx] }));

  // ---- Mode A: In-place overlay (preserve layout) ----
  async function processInplaceClient(pdfArrayBuffer, newNumber) {
    const pdfLibMod = await import("pdf-lib");
    const fontkitMod = await import("@pdf-lib/fontkit");
    const pdfjs = await loadPdfJs();

    const PDFDocument = pdfLibMod.PDFDocument ?? pdfLibMod.default?.PDFDocument;
    const rgb = pdfLibMod.rgb ?? pdfLibMod.default?.rgb;
    const fontkit = fontkitMod.default || fontkitMod;

    const srcBytes = new Uint8Array(pdfArrayBuffer);
    const pdfDoc = await PDFDocument.load(srcBytes);
    pdfDoc.registerFontkit(fontkit);
    const fontRes = await fetch(FONT_URL, { cache: "no-store" });
    const fontBytes = new Uint8Array(await fontRes.arrayBuffer());
    const uniFont = await pdfDoc.embedFont(fontBytes, { subset: true });

    const task = pdfjs.getDocument({ data: srcBytes, disableWorker: true });
    const jsDoc = await task.promise;

    const PAD = 1.5, LINE_Y_TOL = 2.0, WORD_GAP_TOL = 2.0, DRAW_SIZE = 10;

    for (let i = 1; i <= jsDoc.numPages; i++) {
      const jsPage = await jsDoc.getPage(i);
      const viewport = jsPage.getViewport({ scale: 1.0 });
      const content = await jsPage.getTextContent({ disableCombineTextItems: false });

      // group into lines
      const lines = [];
      for (const it of content.items) {
        const [, , c, d, e, f] = it.transform;
        const x = e, y = f;
        const width = it.width;
        const height = it.height || Math.hypot(c, d);
        let line = lines.find(L => Math.abs(L.yRef - y) <= LINE_Y_TOL);
        if (!line) { line = { yRef: y, items: [] }; lines.push(line); }
        line.items.push({ str: it.str, x, y, width, height });
      }
      lines.sort((a,b)=>b.yRef - a.yRef);
      lines.forEach(L => L.items.sort((a,b)=>a.x - b.x));

      // build spans
      for (const L of lines) {
        let text = ""; const spans = [];
        for (let idx = 0; idx < L.items.length; idx++) {
          const it = L.items[idx];
          if (idx > 0) {
            const prev = L.items[idx - 1];
            const gap = it.x - (prev.x + prev.width);
            if (gap > WORD_GAP_TOL) { spans.push({ start: text.length, end: text.length+1, itemIndex: -1 }); text += " "; }
          }
          const start = text.length; text += it.str; spans.push({ start, end: text.length, itemIndex: idx });
        }
        L.text = text; L.spans = spans;
      }

      const page = pdfDoc.getPage(i - 1);
      const pageW = page.getWidth(), pageH = page.getHeight();
      const scaleX = pageW / viewport.width, scaleY = pageH / viewport.height;

      for (const L of lines) {
        const raw = L.text || ""; if (!raw) continue;
        const check = convertVanityToDigits(normalizeWeird(raw));
        let m; PHONE_RE.lastIndex = 0;
        while ((m = PHONE_RE.exec(check)) !== null) {
          const mStart = m.index, mEnd = m.index + m[0].length;
          const used = [];
          for (const s of L.spans) {
            if (s.itemIndex < 0) continue;
            if (s.start < mEnd && s.end > mStart) used.push(L.items[s.itemIndex]);
          }
          if (!used.length) continue;

          const minX = Math.min(...used.map(u => u.x)) - PAD;
          const maxX = Math.max(...used.map(u => u.x + u.width)) + PAD;
          const topY = Math.max(...used.map(u => u.y)) + PAD;
          const bottomY = Math.min(...used.map(u => u.y - u.height)) - PAD;

          const pdfX = minX * scaleX;
          const pdfWidth = (maxX - minX) * scaleX;
          const pdfTopFromBottom = pageH - topY * scaleY;
          const pdfHeight = (topY - bottomY) * scaleY;
          const pdfY = pdfTopFromBottom - pdfHeight;

          page.drawRectangle({ x: pdfX, y: pdfY, width: pdfWidth, height: pdfHeight, color: rgb(1,1,1) });
          page.drawText(newNumber, { x: pdfX + 0.6, y: pdfY + 0.6, size: DRAW_SIZE, font: uniFont, maxWidth: pdfWidth - 1.2 });
        }
      }
    }

    const out = await pdfDoc.save();
    return bytesToDataUrl("application/pdf", out);
  }

  // ---- Mode B: Presentable (title safe + ordered bullets) ----
  async function processPresentableClient(pdfArrayBuffer, newNumber) {
    const pdfLibMod = await import("pdf-lib");
    const fontkitMod = await import("@pdf-lib/fontkit");
    const { PDFDocument } = pdfLibMod;
    const fontkit = fontkitMod.default || fontkitMod;

    const srcBytes = new Uint8Array(pdfArrayBuffer);
    const allText = await extractTextAllPages(srcBytes);

    const rawLines = allText.split(/\r?\n/).map(s => s.trim());
    const title = chooseHeading(rawLines);

    // Body = everything after the heading occurrence, else whole text minus first non-empty
    const firstIdx = rawLines.findIndex(s => s.trim() === title);
    const bodyRaw = (firstIdx >= 0 ? rawLines.slice(firstIdx + 1) : rawLines.slice(1)).join("\n");

    // Normalize -> vanity to digits -> replace numbers
    let body = convertVanityToDigits(normalizeWeird(bodyRaw));
    body = body.replace(PHONE_RE, newNumber);

    // Build ordered blocks (preserve original order)
    const blocks = [];
    let para = [];
    const flushPara = () => { if (para.length) { blocks.push({ type: "para", text: para.join(" ") }); para = []; } };
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) { flushPara(); continue; }
      if (isBulletLine(line)) {
        flushPara();
        blocks.push({ type: "bullet", text: line.replace(/^([•·*]\s+|-\s+)/, "") });
      } else {
        para.push(line);
      }
    }
    flushPara();

    // Create output PDF
    const out = await PDFDocument.create();
    out.registerFontkit(fontkit);
    const fontRes = await fetch(FONT_URL, { cache: "no-store" });
    const fontBytes = new Uint8Array(await fontRes.arrayBuffer());
    const font = await out.embedFont(fontBytes, { subset: true });

    // Try to match source page size; fallback to Letter
    let pageW = 612, pageH = 792;
    try {
      const srcDoc = await PDFDocument.load(srcBytes);
      const first = srcDoc.getPages()[0];
      pageW = first?.getWidth?.() || pageW;
      pageH = first?.getHeight?.() || pageH;
    } catch {}

    let page = out.addPage([pageW, pageH]);
    const margin = 36;
    const bodySize = 11;
    const lineH = 16;

    // Keep a safe top margin so title never clips:
    let cursorY = pageH - margin - 4; // top baseline below the top margin

    const widthOf = (t, size) => font.widthOfTextAtSize(t, size);
    const ensure = (need) => {
      if (cursorY - need < margin) {
        page = out.addPage([pageW, pageH]);
        cursorY = pageH - margin - 4;
      }
    };

    // Soft break very long tokens (no natural spaces) at measured widths
    const breakLongToken = (token, size, maxWidth) => {
      const pieces = [];
      let cur = "";
      for (const ch of token) {
        const t = cur + ch;
        if (widthOf(t, size) <= maxWidth) cur = t;
        else { if (cur) pieces.push(cur); cur = ch; }
      }
      if (cur) pieces.push(cur);
      return pieces;
    };

    const drawWrappedAt = (xLeft, text, size, extraAfter = 6, customLH) => {
      const lh = customLH || lineH;
      const maxWidth = pageW - xLeft - margin;
      const rawTokens = text.split(/\s+/);
      const tokens = [];
      for (const tok of rawTokens) {
        if (widthOf(tok, size) > maxWidth) tokens.push(...breakLongToken(tok, size, maxWidth));
        else tokens.push(tok);
      }
      let cur = "";
      const lines = [];
      for (const w of tokens) {
        const t = cur ? cur + " " + w : w;
        if (widthOf(t, size) <= maxWidth) cur = t;
        else { if (cur) lines.push(cur); cur = w; }
      }
      if (cur) lines.push(cur);

      const need = lines.length * lh;
      ensure(need);
      for (const ln of lines) {
        page.drawText(ln, { x: xLeft, y: cursorY, size, font, lineHeight:
