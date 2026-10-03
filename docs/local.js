// Self-hosted runtime for Ken's Home Warehouse.
// Stands in for the claude.ai capabilities the app uses (db, assets, downloads, sample)
// with free, on-device versions: IndexedDB storage, local photo storage, and photo
// reading via Tesseract (printed text) + MobileNet (object recognition / visual match).
(function () {
  "use strict";
  const BASE = new URL(".", location.href).href;
  const vendor = (p) => BASE + "vendor/" + p;

  // ---------- IndexedDB ----------
  let dbp = null;
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("khw", 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("docs"); d.createObjectStore("blobs"); d.createObjectStore("emb"); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await idb();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode); const st = t.objectStore(store); let out;
      Promise.resolve(fn(st)).then((v) => { out = v; });
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function getAll(store) {
    const d = await idb();
    return new Promise((res, rej) => {
      const out = new Map(); const r = d.transaction(store).objectStore(store).openCursor();
      r.onsuccess = () => { const c = r.result; if (c) { out.set(c.key, c.value); c.continue(); } else res(out); };
      r.onerror = () => rej(r.error);
    });
  }
  const rid = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "0123456789abcdefghijklmnopqrstuvwxyz"[b % 36]).join("");

  // ---------- documents (same shape as the claude.ai db capability) ----------
  const docs = new Map(); const listeners = new Set();
  const segs = (p) => p.split("/");
  function snapDoc(path) { const v = docs.get(path); return { id: segs(path).pop(), exists: v !== undefined, data: () => v, metadata: { fromCache: false, hasPendingWrites: false } }; }
  function snapCol(path) {
    const n = segs(path).length + 1, out = [];
    docs.forEach((v, k) => { if (k.startsWith(path + "/") && segs(k).length === n) out.push(snapDoc(k)); });
    out.sort((a, b) => (a.id < b.id ? -1 : 1));
    return { docs: out, size: out.length, empty: !out.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function notify() { queueMicrotask(() => listeners.forEach((l) => { try { l.cb(l.kind === "col" ? snapCol(l.path) : snapDoc(l.path)); } catch (e) { console.error(e); } })); }
  async function write(path, value) {
    if (value === undefined) { docs.delete(path); await tx("docs", "readwrite", (s) => s.delete(path)); }
    else { const v = JSON.parse(JSON.stringify(value)); docs.set(path, v); await tx("docs", "readwrite", (s) => s.put(v, path)); }
    notify();
  }
  const bad = (m) => Object.assign(new Error(m), { code: "invalid_argument" });
  function docRef(path) {
    return {
      id: segs(path).pop(), path,
      get: async () => snapDoc(path),
      set: (d) => write(path, d),
      update: async (d) => { const cur = docs.get(path); if (cur === undefined) throw bad("No document to update"); await write(path, { ...cur, ...d }); },
      delete: () => write(path, undefined),
      onSnapshot(cb) { const l = { kind: "doc", path, cb }; listeners.add(l); queueMicrotask(() => cb(snapDoc(path))); return () => listeners.delete(l); },
      collection: (c) => colRef(path + "/" + c),
    };
  }
  function colRef(path) {
    return {
      path,
      doc: (id) => docRef(path + "/" + (id || rid(20))),
      add: async (d) => { const r = docRef(path + "/" + rid(20)); await r.set(d); return r; },
      get: async () => snapCol(path),
      onSnapshot(cb) { const l = { kind: "col", path, cb }; listeners.add(l); queueMicrotask(() => cb(snapCol(path))); return () => listeners.delete(l); },
    };
  }
  const db = { doc: docRef, collection: colRef };

  // ---------- photos ----------
  const urls = new Map();
  const assets = {
    async upload(blob) {
      const id = rid(32);
      try { await tx("blobs", "readwrite", (s) => s.put(blob, id)); }
      catch (e) { throw Object.assign(new Error("Storage full"), { code: "quota_or_state" }); }
      urls.set(id, URL.createObjectURL(blob));
      return { id, url: urls.get(id), sizeBytes: blob.size, contentType: blob.type };
    },
    async delete(id) {
      if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
      await tx("blobs", "readwrite", (s) => s.delete(id)); await tx("emb", "readwrite", (s) => s.delete(id)).catch(() => {});
      return { deleted: true };
    },
  };
  async function blobOf(id) { return tx("blobs", "readonly", (s) => reqP(s.get(id))); }

  // ---------- downloads ----------
  const downloads = {
    async save({ filename, data }) {
      const b = data instanceof Blob ? data : new Blob([data], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = filename;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      return { status: "saved" };
    },
  };

  // ---------- photo reader ----------
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Couldn't load " + src)); document.head.appendChild(s); });
  }
  let ocrP = null, tfP = null;
  function note(text) { const t = document.getElementById("i-photo-msg"); if (t && /Reading|Still working|Loading/.test(t.textContent)) t.textContent = text; }
  function ocrWorker() {
    if (!ocrP) ocrP = (async () => {
      note("Loading the text reader (first time only)…");
      await loadScript(vendor("tesseract.min.js"));
      const w = await window.Tesseract.createWorker("eng", 1, { workerPath: vendor("worker.min.js"), corePath: vendor("core"), langPath: vendor("lang"), gzip: true });
      await w.setParameters({ tessedit_pageseg_mode: "11" }); // sparse text: labels scattered over packaging
      return w;
    })().catch((e) => { ocrP = null; throw e; });
    return ocrP;
  }
  function vision() {
    if (!tfP) tfP = (async () => {
      note("Loading the object recogniser (first time only)…");
      await loadScript(vendor("tf.min.js")); await loadScript(vendor("imagenet_classes.js"));
      const tf = window.tf; await tf.ready();
      const model = await tf.loadLayersModel(vendor("mobilenet/model.json"));
      const emb = tf.model({ inputs: model.inputs, outputs: model.getLayer("global_average_pooling2d_1").output });
      return { tf, model, emb };
    })().catch((e) => { tfP = null; throw e; });
    return tfP;
  }
  async function tensorOf(tf, blob) {
    const bmp = await createImageBitmap(blob);
    return tf.tidy(() => {
      const img = tf.browser.fromPixels(bmp).toFloat();
      const [h, w] = img.shape; const s = Math.min(h, w); // centre square crop
      const crop = img.slice([Math.floor((h - s) / 2), Math.floor((w - s) / 2), 0], [s, s, 3]);
      return tf.image.resizeBilinear(crop, [224, 224]).div(127.5).sub(1).expandDims(0);
    });
  }
  async function classify(blob) {
    const { tf, model, emb } = await vision();
    const x = await tensorOf(tf, blob);
    const [p, e] = tf.tidy(() => [model.predict(x).reshape([-1]), emb.predict(x).reshape([-1])]);
    const probs = await p.data(), vec = Array.from(await e.data()); tf.dispose([x, p, e]);
    const top = Array.from(probs).map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 3)
      .map(([v, i]) => ({ prob: v, label: String(window.IMAGENET_CLASSES[i] || "") }));
    return { top, vec };
  }
  async function embOf(id) {
    let v = await tx("emb", "readonly", (s) => reqP(s.get(id))).catch(() => null);
    if (v) return v;
    const b = await blobOf(id); if (!b) return null;
    v = (await classify(b)).vec; await tx("emb", "readwrite", (s) => s.put(v, id)).catch(() => {});
    return v;
  }
  function cos(a, b) { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); }

  const SKIP = /premium quality|new and improved|registration|\blot\b|\bmfg\b|\bmfd\b|www\.|\btel\b|\bfax\b|sdn\.? ?bhd|\bltd\b|\bexp\b|batch|barcode|made in|manufactured|distributed/i;
  const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Of|And|For|With)\b/g, (w) => w.toLowerCase());
  // coloured print (orange, red, blue) turns pale in plain greyscale; taking each pixel's darkest
  // channel keeps it dark on white packaging. Small photos are enlarged so fine print is readable.
  async function prep(blob) {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(2, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(bmp, 0, 0, c.width, c.height);
    const im = g.getImageData(0, 0, c.width, c.height), d = im.data; let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) { const v = Math.min(d[i], d[i + 1], d[i + 2]); d[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
    const k = 255 / Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) { const v = (d[i] - lo) * k; d[i] = d[i + 1] = d[i + 2] = v; }
    g.putImageData(im, 0, 0);
    return c;
  }
  async function ocr(blob) {
    const w = await ocrWorker();
    const { data } = await w.recognize(await prep(blob));
    return (data.lines || []).map((l) => ({ text: l.text.replace(/\s+/g, " ").trim(), conf: l.confidence, h: l.bbox.y1 - l.bbox.y0 }));
  }
  function nameFromLines(lines) {
    const c = lines.filter((l) => l.conf >= 70 && l.text.length >= 4 && !SKIP.test(l.text)
      && (l.text.match(/[a-z]/gi) || []).length >= Math.max(4, l.text.length * 0.6) && /[a-z]{3,}/i.test(l.text));
    if (!c.length) return "";
    c.sort((a, b) => b.h * b.conf - a.h * a.conf);
    const t = c[0].text.replace(/[^\w\s&'+\-./]/g, "").trim();
    return t === t.toUpperCase() ? titleCase(t) : t;
  }
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function lastDay(y, m) { return new Date(y, m, 0).getDate(); }
  function expiryFrom(text) {
    const found = []; const add = (y, m, d) => { y = +y; m = +m; if (y < 2015 || y > 2060 || m < 1 || m > 12) return; d = d ? +d : lastDay(y, m); if (d < 1 || d > lastDay(y, m)) return; found.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`); };
    const t = text.replace(/(\d)[Oo]/g, (_, d) => d + "0").replace(/[Oo](\d)/g, (_, d) => "0" + d);
    for (const m of t.matchAll(/\b(20\d\d)\s*[-/.]\s*(\d{1,2})(?:\s*[-/.]\s*(\d{1,2}))?\b/g)) add(m[1], m[2], m[3]);
    for (const m of t.matchAll(/\b(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(20\d\d)\b/g)) add(m[3], m[2], m[1]); // day first
    for (const m of t.matchAll(/(?:^|[^\d/.-])(\d{1,2})\s*[-/.]\s*(20\d\d)\b/g)) add(m[2], m[1]);
    for (const m of t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*[-/]?\s*(20\d\d)\b/gi)) add(m[2], MONTHS[m[1].toLowerCase()]);
    return found.sort().pop() || ""; // the latest printed date is normally the expiry (the other is manufacture)
  }
  function noteFrom(text) {
    const m = text.match(/\bpack of \d+\b|\b\d+\s?(?:pcs|pieces|tablets|capsules|caps|sachets|sheets|rolls)\b|\b\d+(?:\.\d+)?\s?(?:ml|l|g|gm|kg|mg)\b/gi);
    return m ? [...new Set(m.map((s) => s.trim()))].slice(0, 3).join(", ") : "";
  }
  const CATS = [
    ["First aid", /swab|plaster|bandage|gauze|antiseptic|band.?aid|thermometer|first aid|mask|syringe/i],
    ["Medicine", /tablet|capsule|\bmg\b|syrup|panadol|paracetamol|vitamin|medicine|pill|ointment|cream|pill bottle/i],
    ["Electronics", /cable|charger|usb|hdmi|batter|adapter|remote|mouse|keyboard|phone|earphone|headphone|laptop|modem|router|ipod|monitor/i],
    ["Tools", /drill|screwdriver|hammer|wrench|spanner|plier|tape measure|saw|chisel|power drill|allen/i],
    ["Food", /sauce|noodle|rice|biscuit|snack|coffee|\btea\b|milk|sugar|salt|cooking oil|cereal|choco|candy|instant/i],
    ["Toiletries", /shampoo|soap|toothpaste|toothbrush|lotion|sunscreen|tissue|deodorant|razor|conditioner|hair/i],
    ["Cleaning", /detergent|bleach|cleaner|sponge|disinfect|softener|dishwash/i],
    ["Documents", /passport|certificate|warranty|manual|document|envelope/i],
    ["Stationery", /\bpen\b|pencil|notebook|stapler|scissors|marker|glue|envelope/i],
  ];
  const catOf = (t) => (CATS.find(([, re]) => re.test(t)) || [""])[0];
  const labelName = (l) => titleCase(l.split(",")[0].trim());

  async function readItem(blob) {
    const [o, c] = await Promise.allSettled([ocr(blob), classify(blob)]);
    if (o.status === "rejected" && c.status === "rejected") throw Object.assign(new Error(String(o.reason)), { code: "upstream_error" });
    const lines = o.status === "fulfilled" ? o.value : [];
    const text = lines.map((l) => l.text).join("\n");
    const top = c.status === "fulfilled" ? c.value.top[0] : null;
    let name = nameFromLines(lines);
    if (!name && top && top.prob >= 0.15) name = labelName(top.label);
    return { name, category: catOf(text + " " + name + " " + (top ? top.label : "")), expires: expiryFrom(text), note: noteFrom(text) };
  }

  const toks = (s) => (String(s).toLowerCase().match(/[a-z0-9]{3,}/g) || []).map((w) => w.replace(/s$/, ""));
  async function findItem(blob) {
    const [o, c] = await Promise.allSettled([ocr(blob), classify(blob)]);
    if (c.status === "rejected" && o.status === "rejected") throw Object.assign(new Error(String(c.reason)), { code: "upstream_error" });
    const lines = o.status === "fulfilled" ? o.value.filter((l) => l.conf >= 60) : [];
    const textToks = new Set(toks(lines.map((l) => l.text).join(" ")));
    const cls = c.status === "fulfilled" ? c.value : null;
    const labelToks = new Set(cls ? cls.top.flatMap((t) => toks(t.label)) : []);
    const out = [];
    for (const [path, it] of docs) {
      if (!path.startsWith("items/") || segs(path).length !== 2) continue;
      const nt = toks(it.name); if (!nt.length) continue;
      const textHit = nt.filter((t) => textToks.has(t)).length / nt.length;
      const labelHit = nt.some((t) => labelToks.has(t));
      let vis = 0;
      if (cls && it.photo) { const v = await embOf(it.photo).catch(() => null); if (v) vis = cos(cls.vec, v); }
      const confidence = vis >= 0.86 || textHit >= 0.8 ? "high" : vis >= 0.78 || textHit >= 0.5 || labelHit ? "medium" : vis >= 0.7 ? "low" : "";
      if (confidence) out.push({ id: segs(path)[1], confidence, score: Math.max(vis, textHit, labelHit ? 0.75 : 0) });
    }
    out.sort((a, b) => b.score - a.score);
    let object = nameFromLines(lines);
    if (!object && cls && cls.top[0].prob >= 0.15) object = labelName(cls.top[0].label);
    return { object, category: catOf(lines.map((l) => l.text).join(" ") + " " + object + " " + (cls ? cls.top[0].label : "")), matches: out.slice(0, 5) };
  }

  // the app calls sample.json(prompt, {images}); route the two prompts it sends to the local reader
  const sample = Object.assign(async () => ({ text: "" }), {
    limits: async () => ({ images: { maxCount: 1 } }),
    async json(prompt, opts) {
      const blob = opts && opts.images && opts.images[0];
      if (!blob) throw Object.assign(new Error("No photo"), { code: "invalid_request" });
      if (opts.signal && opts.signal.aborted) throw { code: "cancelled", message: "Stopped" };
      const work = /Registered items:/.test(prompt) ? findItem(blob) : readItem(blob);
      if (!opts.signal) return work;
      return Promise.race([work, new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej({ code: "cancelled", message: "Stopped" })))]);
    },
  });

  // ---------- boot ----------
  const ready = (async () => {
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
    const [d, b] = await Promise.all([getAll("docs"), getAll("blobs")]);
    d.forEach((v, k) => docs.set(k, v));
    b.forEach((blob, id) => urls.set(id, URL.createObjectURL(blob)));
  })();
  const caps = { db, assets, downloads, sample, user: null, permissions: null };
  window.LOCAL_RUNTIME = {
    use: async (name) => { try { await ready; } catch (e) { return null; } return caps[name] || null; },
    photoUrl: (id) => urls.get(id) || "",
    _test: { expiryFrom, nameFromLines, noteFrom, catOf },
  };
})();
