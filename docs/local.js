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
      const r = indexedDB.open("khw", 2);
      r.onupgradeneeded = () => {
        const d = r.result, have = d.objectStoreNames;
        ["docs", "blobs", "emb", "outbox", "kv"].forEach((n) => { if (!have.contains(n)) d.createObjectStore(n); });
      };
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
    const ts = Date.now();
    if (value === undefined) { docs.delete(path); await tx("docs", "readwrite", (s) => s.delete(path)); }
    else { const v = JSON.parse(JSON.stringify(value)); v._ts = ts; docs.set(path, v); await tx("docs", "readwrite", (s) => s.put(v, path)); }
    if (sync.user) { await outboxPut(path, { ts }); schedule(1500); }
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
      if (sync.user) { await outboxPut("photo:" + id, { op: "up" }); schedule(1500); }
      return { id, url: urls.get(id), sizeBytes: blob.size, contentType: blob.type };
    },
    async delete(id) {
      if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
      await tx("blobs", "readwrite", (s) => s.delete(id)); await tx("emb", "readwrite", (s) => s.delete(id)).catch(() => {});
      if (sync.user) { await outboxPut("photo:" + id, { op: "del" }); schedule(1500); }
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

  // ---------- cloud sync (optional, Supabase) ----------
  // The phone stays the main copy. Every change is queued in "outbox" and pushed when online;
  // other devices' changes are pulled by server time. Newest edit (by _ts) wins.
  const kvGet = (k) => tx("kv", "readonly", (s) => reqP(s.get(k))).catch(() => undefined);
  const kvSet = (k, v) => tx("kv", "readwrite", (s) => s.put(v, k));
  function outboxPut(k, v) { return tx("outbox", "readwrite", (s) => s.put(v, k)); }
  const sync = { client: null, user: null, status: "off", err: "", last: 0, busy: false, again: false, timer: null, subs: new Set() };
  function setStatus(st, err) { sync.status = st; sync.err = err || ""; sync.subs.forEach((f) => { try { f(); } catch (e) {} }); }
  function cloudCfg() {
    const c = window.KHW_CLOUD || {}; let s = {};
    try { s = JSON.parse(localStorage.getItem("khw-cloud") || "{}"); } catch (e) {}
    return { url: (c.url || s.url || "").trim(), key: (c.key || s.key || "").trim() };
  }
  async function cloudInit() {
    const c = cloudCfg();
    if (!c.url || !c.key) { sync.client = null; setStatus("off"); return; }
    try {
      if (!window.supabase) await loadScript(vendor("supabase.js"));
      sync.client = window.supabase.createClient(c.url, c.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "khw-auth" } });
      sync.last = (await kvGet("lastSync")) || 0;
      const { data } = await sync.client.auth.getSession();
      sync.user = data && data.session ? data.session.user : null;
      if (sync.user) { await linkUser(); syncNow(); } else setStatus("signed-out");
    } catch (e) { setStatus("error", "Couldn't start cloud sync: " + (e.message || e)); }
  }
  async function linkUser() {
    // first sign-in on this device (or a different account): queue everything already here for upload
    if ((await kvGet("linkedUser")) === sync.user.id) return;
    const t = Date.now();
    for (const [path, v] of docs) await outboxPut(path, { ts: v._ts || t });
    for (const id of urls.keys()) await outboxPut("photo:" + id, { op: "up" });
    await kvSet("lastPull", "1970-01-01T00:00:00Z"); await kvSet("linkedUser", sync.user.id);
  }
  function schedule(ms) { if (!sync.user) return; clearTimeout(sync.timer); sync.timer = setTimeout(syncNow, ms); }
  async function syncNow() {
    if (!sync.client || !sync.user) return;
    if (sync.busy) { sync.again = true; return; }
    sync.busy = true; setStatus("syncing");
    try {
      await push(); await pull();
      sync.last = Date.now(); await kvSet("lastSync", sync.last); setStatus("ok");
    } catch (e) {
      setStatus("error", navigator.onLine === false ? "Offline. Changes are kept on this phone and sync when you're back online." : "Sync didn't finish: " + (e.message || e));
    } finally {
      sync.busy = false;
      if (sync.again) { sync.again = false; schedule(300); } else schedule(30000);
    }
  }
  async function push() {
    const box = await getAll("outbox"); if (!box.size) return;
    const uid = sync.user.id, rows = [], photos = [];
    box.forEach((v, k) => (k.startsWith("photo:") ? photos : rows).push([k, v]));
    const bucket = sync.client.storage.from("photos");
    for (const [k, v] of photos) {
      const id = k.slice(6), file = uid + "/" + id;
      if (v.op === "del") { const { error } = await bucket.remove([file]); if (error) throw error; }
      else {
        const b = await blobOf(id);
        if (b) { const { error } = await bucket.upload(file, b, { upsert: true, contentType: b.type || "image/jpeg" }); if (error) throw error; }
      }
      await tx("outbox", "readwrite", (s) => s.delete(k));
    }
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const payload = chunk.map(([path, v]) => {
        const d = docs.get(path);
        return d === undefined ? { user_id: uid, path, data: null, ts: v.ts, deleted: true } : { user_id: uid, path, data: d, ts: d._ts || v.ts, deleted: false };
      });
      const { error } = await sync.client.from("docs").upsert(payload, { onConflict: "user_id,path" });
      if (error) throw error;
      const now = await getAll("outbox"); // keep entries edited again while this chunk was uploading
      await tx("outbox", "readwrite", (s) => chunk.forEach(([path, v]) => { const cur = now.get(path); if (cur && cur.ts === v.ts) s.delete(path); }));
    }
  }
  async function pull() {
    let since = (await kvGet("lastPull")) || "1970-01-01T00:00:00Z", changed = false;
    const pending = await getAll("outbox");
    for (;;) {
      const { data, error } = await sync.client.from("docs").select("path,data,ts,deleted,server_ts")
        .gt("server_ts", since).order("server_ts", { ascending: true }).limit(500);
      if (error) throw error;
      for (const r of data) {
        since = r.server_ts;
        const cur = docs.get(r.path), mine = Math.max(cur ? cur._ts || 0 : 0, pending.has(r.path) ? pending.get(r.path).ts || 0 : 0);
        if (Number(r.ts) <= mine) continue;
        if (r.deleted || !r.data) { if (cur === undefined) continue; docs.delete(r.path); await tx("docs", "readwrite", (s) => s.delete(r.path)); }
        else { docs.set(r.path, r.data); await tx("docs", "readwrite", (s) => s.put(r.data, r.path)); }
        changed = true;
      }
      await kvSet("lastPull", since);
      if (data.length < 500) break;
    }
    if (changed) notify();
    // fetch photos that other devices added
    const bucket = sync.client.storage.from("photos"); let got = false;
    for (const [path, v] of docs) {
      if (!path.startsWith("items/") || !v.photo || urls.has(v.photo)) continue;
      const { data: b, error } = await bucket.download(sync.user.id + "/" + v.photo);
      if (error || !b) continue;
      await tx("blobs", "readwrite", (s) => s.put(b, v.photo)); urls.set(v.photo, URL.createObjectURL(b)); got = true;
    }
    if (got) notify();
  }
  const cloud = {
    get state() { return { status: sync.status, err: sync.err, last: sync.last, email: sync.user ? sync.user.email : "", configured: !!sync.client || !!cloudCfg().url } ; },
    subscribe(f) { sync.subs.add(f); return () => sync.subs.delete(f); },
    async configure(url, key) { localStorage.setItem("khw-cloud", JSON.stringify({ url, key })); await cloudInit(); },
    async signIn(email, password, create) {
      if (!sync.client) throw new Error("Cloud sync isn't set up yet.");
      const fn = create ? sync.client.auth.signUp({ email, password }) : sync.client.auth.signInWithPassword({ email, password });
      const { data, error } = await fn; if (error) throw error;
      if (!data.session) throw new Error("Account created. Check your email to confirm it, then sign in.");
      sync.user = data.session.user; await linkUser(); await syncNow();
    },
    async signOut() { if (sync.client) await sync.client.auth.signOut(); sync.user = null; clearTimeout(sync.timer); setStatus("signed-out"); },
    syncNow: () => syncNow(),
  };
  window.addEventListener("online", () => schedule(500));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") schedule(500); });

  // ---------- cloud sync screen (Clean-up tab) and header badge ----------
  const h = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function ago(t) { if (!t) return "never"; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : new Date(t).toLocaleString(); }
  function cloudUI() {
    const root = document.getElementById("ext-check"), badge = document.getElementById("cloud-badge");
    if (!root) return;
    const st = cloud.state;
    if (badge) {
      badge.hidden = st.status === "off";
      badge.textContent = { ok: "☁ Synced", syncing: "☁ Syncing…", error: "☁ Not synced", "signed-out": "☁ Signed out" }[st.status] || "";
      badge.dataset.state = st.status;
    }
    const mode = st.status === "off" ? "setup" : st.status === "signed-out" ? "signin" : "on";
    if (root.dataset.mode !== mode) {
      root.dataset.mode = mode;
      root.innerHTML = mode === "setup" ? `<div class="panel"><h2 style="margin:0">Cloud sync</h2>
          <p class="small muted" style="margin:0">Optional. Backs your inventory up online and keeps it the same on all your devices, using a free Supabase project. Until then, everything stays on this phone.</p>
          <label class="f">Supabase project URL<input class="in" id="cl-url" placeholder="https://xxxx.supabase.co" autocomplete="off" autocapitalize="off"></label>
          <label class="f">Supabase anon public key<input class="in" id="cl-key" placeholder="eyJ…" autocomplete="off" autocapitalize="off"></label>
          <div class="actions"><button class="btn primary" id="cl-save">Connect</button></div><div class="small" id="cl-msg"></div></div>`
        : mode === "signin" ? `<form class="panel" id="cl-form"><h2 style="margin:0">Cloud sync: sign in</h2>
          <p class="small muted" style="margin:0">Sign in to upload what's on this phone and keep it in sync. Use the same account on every device.</p>
          <label class="f">Email<input class="in" id="cl-email" type="email" autocomplete="username" autocapitalize="off"></label>
          <label class="f">Password<input class="in" id="cl-pass" type="password" autocomplete="current-password"></label>
          <div class="actions"><button class="btn primary" type="submit">Sign in</button><button class="btn" type="button" id="cl-create">Create account</button></div>
          <div class="small" id="cl-msg"></div></form>`
        : `<div class="panel"><h2 style="margin:0">Cloud sync</h2><div id="cl-status"></div>
          <div class="actions"><button class="btn" id="cl-now">Sync now</button><button class="btn danger" id="cl-out">Sign out</button></div></div>`;
    }
    const s2 = document.getElementById("cl-status");
    if (s2) s2.innerHTML = `<div>Signed in as <strong>${h(st.email)}</strong></div><div class="small ${st.status === "error" ? "" : "muted"}">${st.status === "syncing" ? "Syncing…" : st.status === "error" ? h(st.err) : "Last synced " + h(ago(st.last))}</div>`;
    if (st.status === "error" && mode !== "on") { const m = document.getElementById("cl-msg"); if (m) m.textContent = st.err; }
  }
  function cloudEvents() {
    const msg = (t) => { const m = document.getElementById("cl-msg"); if (m) m.textContent = t; };
    document.addEventListener("click", async (e) => {
      const t = e.target.closest("#cl-save,#cl-create,#cl-now,#cl-out,#cloud-badge"); if (!t) return;
      if (t.id === "cloud-badge") { const tab = document.querySelector('[data-tab="check"]'); if (tab) tab.click(); setTimeout(() => document.getElementById("ext-check").scrollIntoView({ behavior: "smooth" }), 50); }
      if (t.id === "cl-save") {
        const url = document.getElementById("cl-url").value.trim(), key = document.getElementById("cl-key").value.trim();
        if (!/^https:\/\/.+/.test(url) || key.length < 20) { msg("Paste the Project URL (starts with https://) and the anon public key."); return; }
        msg("Connecting…"); await cloud.configure(url, key);
      }
      if (t.id === "cl-create") {
        const em = document.getElementById("cl-email").value.trim(), pw = document.getElementById("cl-pass").value;
        if (!em || pw.length < 6) { msg("Enter your email and a password of at least 6 characters."); return; }
        msg("Creating account…"); try { await cloud.signIn(em, pw, true); } catch (err) { msg(err.message || String(err)); }
      }
      if (t.id === "cl-now") cloud.syncNow();
      if (t.id === "cl-out") { if (t.classList.contains("armed")) { await cloud.signOut(); } else { t.classList.add("armed"); t.textContent = "Tap again to sign out"; setTimeout(() => { t.classList.remove("armed"); t.textContent = "Sign out"; }, 3500); } }
    });
    document.addEventListener("submit", async (e) => {
      if (e.target.id !== "cl-form") return; e.preventDefault();
      const em = document.getElementById("cl-email").value.trim(), pw = document.getElementById("cl-pass").value;
      if (!em || !pw) { msg("Enter your email and password."); return; }
      msg("Signing in…"); try { await cloud.signIn(em, pw, false); } catch (err) { msg(err.message || String(err)); }
    });
  }
  document.addEventListener("DOMContentLoaded", () => {
    const stat = document.getElementById("stat");
    if (stat && !document.getElementById("cloud-badge")) {
      const b = document.createElement("button"); b.type = "button"; b.id = "cloud-badge"; b.hidden = true; b.className = "cloud-badge";
      stat.insertAdjacentElement("afterend", b);
    }
    cloud.subscribe(cloudUI); cloudEvents(); cloudUI(); setInterval(cloudUI, 30000);
  });

  // ---------- boot ----------
  const ready = (async () => {
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
    const [d, b] = await Promise.all([getAll("docs"), getAll("blobs")]);
    d.forEach((v, k) => docs.set(k, v));
    b.forEach((blob, id) => urls.set(id, URL.createObjectURL(blob)));
    cloudInit(); // runs in the background; the app works without it
  })();
  const caps = { db, assets, downloads, sample, user: null, permissions: null };
  window.LOCAL_RUNTIME = {
    use: async (name) => { try { await ready; } catch (e) { return null; } return caps[name] || null; },
    photoUrl: (id) => urls.get(id) || "",
    cloud,
    _test: { expiryFrom, nameFromLines, noteFrom, catOf },
  };
})();
