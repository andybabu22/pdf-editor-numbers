// pages/index.js
import { useState } from "react";
import { motion } from "framer-motion";
import JSZip from "jszip";

// Unicode font (handles ™ ® ℗ bullets etc.)
const FONT_URL =
  "https://raw.githubusercontent.com/GreatWizard/notosans-fontface/master/fonts/NotoSans-Regular.ttf";

// Robust phone detector: digits + many separators/parens
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

// Normalize odd separators & spacing
function normalizeWeird(text) {
  return text
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "") // zero-width + soft hyphen
    .replace(/[⇄⇋•·–—_]+/g, "-")                 // unify odd separators
    .replace(/\s{2,}/g, " ")                      // squeeze spaces
    .trim();
}

// ---- PDF.js helpers (client) ----
async function loadPdfJs() {
  // Legacy build; we do NOT set workerSrc and always call getDocument with { disableWorker: true }
  const mod = await import("pdfjs-dist/legacy/build/pdf");
  const pdfjs = mod.default?.getDocument ? mod.default : mod;
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

function isBulletLine(line) {
  return /^([•·*]\s+|-\s+)/.test(line);
}

function chooseHeading(rawLines) {
  const candidates = rawLines.slice(0, 25).map(s => s.trim()).filter(Boolean);
  for (const s of candidates) {
    const letters = (s.match(/[A-Za-z]/g) || []).length;
    const digits  = (s.match(/\d/g) || []).length;
    const len = s.length;
    if (len >= 8 && len <= 140 && letters > digits * 2) return s;
  }
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

  // ---- Mode B: Presentable (safe title + ordered bullets) ----
  async function processPresentableClient(pdfArrayBuffer, newNumber) {
    const pdfLibMod = await import("pdf-lib");
    const fontkitMod = await import("@pdf-lib/fontkit");
    const { PDFDocument } = pdfLibMod;
    const fontkit = fontkitMod.default || fontkitMod;

    const srcBytes = new Uint8Array(pdfArrayBuffer);
    const allText = await extractTextAllPages(srcBytes);

    const rawLines = allText.split(/\r?\n/).map(s => s.trim());
    const title = chooseHeading(rawLines);

    const firstIdx = rawLines.findIndex(s => s.trim() === title);
    const bodyRaw = (firstIdx >= 0 ? rawLines.slice(firstIdx + 1) : rawLines.slice(1)).join("\n");

    let body = convertVanityToDigits(normalizeWeird(bodyRaw));
    body = body.replace(PHONE_RE, newNumber);

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

    const out = await PDFDocument.create();
    out.registerFontkit(fontkit);
    const fontRes = await fetch(FONT_URL, { cache: "no-store" });
    const fontBytes = new Uint8Array(await fontRes.arrayBuffer());
    const font = await out.embedFont(fontBytes, { subset: true });

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
    let cursorY = pageH - margin - 4;

    const widthOf = (t, size) => font.widthOfTextAtSize(t, size);
    const ensure = (need) => {
      if (cursorY - need < margin) {
        page = out.addPage([pageW, pageH]);
        cursorY = pageH - margin - 4;
      }
    };

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
        page.drawText(ln, { x: xLeft, y: cursorY, size, font, lineHeight: lh, maxWidth });
        cursorY -= lh;
      }
      cursorY -= extraAfter;
    };

    const drawBullet = (text) => {
      const bulletSize = bodySize;
      const bulletGap = 8;
      const bulletCol = 10;
      const xBullet = margin;
      const xText = margin + bulletCol + bulletGap;
      ensure(lineH);
      page.drawText("•", { x: xBullet, y: cursorY, size: bulletSize, font });
      drawWrappedAt(xText, text, bodySize, 4);
    };

    const drawTitle = (titleText) => {
      const maxWidth = pageW - margin * 2;
      const maxSize = 26;
      const minSize = 14;
      let size = maxSize;
      while (size > minSize && widthOf(titleText, size) > maxWidth) size -= 1;
      if (widthOf(titleText, size) <= maxWidth) {
        ensure(size + 12);
        page.drawText(titleText, { x: margin, y: cursorY, size, font, maxWidth });
        cursorY -= (size + 18);
      } else {
        drawWrappedAt(margin, titleText, minSize, 14, minSize + 6);
      }
    };

    drawTitle(title);
    for (const b of blocks) {
      if (b.type === "bullet") drawBullet(b.text);
      else drawWrappedAt(margin, b.text, bodySize, 10);
    }

    const outBytes = await out.save();
    return bytesToDataUrl("application/pdf", outBytes);
  }

  const handleProcess = async () => {
    setError(""); setResults([]); setProgressDone(0); setOpenPreview({});
    const urls = pdfUrls.split(/\\n|,/).map(u => u.trim()).filter(Boolean);
    if (!urls.length) { setError("Please enter at least one PDF URL."); return; }
    if (!replaceNumber.trim()) { setError("Please enter the replacement phone number."); return; }

    setProgressTotal(urls.length); setLoading(true);
    const processed = [];

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const proxied = `/api/fetch?url=${encodeURIComponent(url)}`;
        const r = await fetch(proxied);
        if (!r.ok) throw new Error(`Fetch failed (${r.status})`);
        const arrBuf = await r.arrayBuffer();

        const downloadUrl =
          layoutMode === "inplace"
            ? await processInplaceClient(arrBuf, replaceNumber)
            : await processPresentableClient(arrBuf, replaceNumber);

        processed.push({
          fileName: url.split("/").pop() || `file_${i + 1}.pdf`,
          sourceUrl: url,
          preview:
            layoutMode === "inplace"
              ? "In-place replacement (layout preserved)."
              : "Heading safe; bullets in order; clean wrap.",
          downloadUrl
        });
      } catch (e) {
        processed.push({
          fileName: url.split("/").pop() || `file_${i + 1}.pdf`,
          sourceUrl: url,
          error: e.message || String(e),
        });
      }
      setProgressDone((prev) => prev + 1);
    }

    setResults(processed);
    setLoading(false);
  };

  const downloadAllZip = async () => {
    const zip = new JSZip();
    const folder = zip.folder("processed_pdfs");
    results.forEach((r, idx) => {
      if (!r.downloadUrl) return;
      const base64 = r.downloadUrl.split(",")[1];
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const safe = (r.fileName || `file_${idx + 1}.pdf`).replace(/[^a-zA-Z0-9._-]/g, "_");
      folder.file(safe, bytes);
    });
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "processed_pdfs.zip";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="min-h-screen p-8">
      <motion.h1 initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
        className="text-3xl font-bold mb-6 text-center text-blue-700">
        📄 Smart PDF Replacer (Local Only)
      </motion.h1>

      {loading && (
        <div className="max-w-3xl mx-auto mb-6">
          <div className="w-full bg-gray-200 h-3 rounded">
            <div className="h-3 bg-blue-600 rounded transition-all" style={{ width: `${percent}%` }} />
          </div>
          <div className="text-sm text-gray-600 mt-1">Processing {progressDone}/{progressTotal} files ({percent}%)</div>
        </div>
      )}

      <div className="max-w-3xl mx-auto space-y-4 bg-white p-5 rounded-xl shadow">
        <label className="block text-sm font-medium text-gray-700">PDF URLs (one per line)</label>
        <textarea
          value={pdfUrls}
          onChange={(e) => setPdfUrls(e.target.value)}
          placeholder={`https://example.com/file1.pdf
https://example.com/file2.pdf`}
          className="w-full p-3 border rounded" rows={6} />

        <label className="block text-sm font-medium text-gray-700">Replacement phone number</label>
        <input value={replaceNumber} onChange={(e) => setReplaceNumber(e.target.value)} placeholder="+1-999-111-2222" className="w-full p-3 border rounded" />

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <select
            value={layoutMode}
            onChange={(e) => setLayoutMode(e.target.value)}
            className="border px-3 py-2 rounded"
            title="Choose output mode"
          >
            <option value="presentable">Presentable (safe title, bullets in order)</option>
            <option value="inplace">Keep Layout (in-place overlay)</option>
          </select>

          <button
            disabled={loading}
            onClick={handleProcess}
            className="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 disabled:opacity-60"
          >
            {loading ? "Processing…" : "Start Processing"}
          </button>
        </div>

        {error && <div className="text-red-600 text-sm">{error}</div>}
      </div>

      {results.length > 0 && (
        <div className="max-w-3xl mx-auto mt-10 space-y-6">
          <div className="flex justify-end">
            <button onClick={downloadAllZip} className="bg-emerald-600 text-white px-4 py-2 rounded hover:bg-emerald-700">
              Download All (ZIP)
            </button>
          </div>

          {results.map((r, i) => (
            <div key={i} className="border p-4 rounded bg-white shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold text-lg truncate">{r.fileName || `File ${i + 1}`}</h3>
                <div className="flex items-center gap-3">
                  {r.downloadUrl && (
                    <>
                      <button onClick={() => togglePreview(i)} className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300 text-sm">
                        {openPreview[i] ? "Hide Preview" : "Preview"}
                      </button>
                      <a href={r.downloadUrl} download className="text-blue-600 underline">Download PDF</a>
                    </>
                  )}
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-1 break-all">Source: {r.sourceUrl || "—"}</p>
              {r.error && <p className="text-red-600 mt-2">Error: {r.error}</p>}
              {openPreview[i] && r.downloadUrl && (
                <div className="mt-3">
                  <iframe src={r.downloadUrl} title={`preview-${i}`} className="w-full h-[480px] border rounded" />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
