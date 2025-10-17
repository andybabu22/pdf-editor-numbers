// pages/api/fetch.js
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send("Missing url");
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).send(`Fetch failed: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    res.send(buf);
  } catch (e) {
    res.status(500).send(typeof e?.message === "string" ? e.message : String(e));
  }
}
