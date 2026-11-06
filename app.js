/* Tote QR — offline Android web app.
   Totes and photos are stored on the phone (IndexedDB). Each tote has a QR sticker
   whose link reopens this app straight into that tote. Photos are shown in the order
   they were taken. */
"use strict";

// ------------------------------------------------------------------ storage
const DB_NAME = "tote-qr";
let dbp = null;
function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("totes", { keyPath: "id" });
      const ph = db.createObjectStore("photos", { keyPath: "id", autoIncrement: true });
      ph.createIndex("toteId", "toteId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function store(name, mode = "readonly") {
  return (await openDB()).transaction(name, mode).objectStore(name);
}
const DB = {
  async totes() {
    const all = await reqP((await store("totes")).getAll());
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async tote(id) { return id ? reqP((await store("totes")).get(id)) : undefined; },
  async putTote(t) { return reqP((await store("totes", "readwrite")).put(t)); },
  async photos(toteId) {
    const list = await reqP((await store("photos")).index("toteId").getAll(toteId));
    return sortTaken(list);
  },
  async addPhoto(p) { return reqP((await store("photos", "readwrite")).add(p)); },
  async deletePhoto(id) { return reqP((await store("photos", "readwrite")).delete(id)); },
  async deleteTote(id) {
    for (const p of await DB.photos(id)) await DB.deletePhoto(p.id);
    return reqP((await store("totes", "readwrite")).delete(id));
  },
  async touch(id) { const t = await DB.tote(id); if (t) { t.updatedAt = Date.now(); await DB.putTote(t); } },
};
// "Arrange as taken": by capture time, then by the order they were added
const sortTaken = (list) => list.sort((a, b) => (a.takenAt - b.takenAt) || (a.seq - b.seq));

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
async function newToteId() {
  for (;;) {
    let id = "";
    const rnd = crypto.getRandomValues(new Uint8Array(6));
    for (const n of rnd) id += ALPHABET[n % ALPHABET.length];
    if (!(await DB.tote(id))) return id;
  }
}

// The link printed in every QR code. Opening it (in-app scanner or phone camera)
// lands on this app with ?tote=ID.
const toteLink = (id) => `${location.origin}${location.pathname}?tote=${id}`;

// ------------------------------------------------------------------ images
// Capture time from the photo's EXIF data (DateTimeOriginal), if present.
async function exifDate(file) {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off), len = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) { // "Exif"
        const t = off + 10, le = v.getUint16(t) === 0x4949;
        const u16 = (o) => v.getUint16(t + o, le), u32 = (o) => v.getUint32(t + o, le);
        const readIFD = (ifd) => {
          const out = {}, n = u16(ifd);
          for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12, tag = u16(e);
            if (tag === 0x8769) out.exif = u32(e + 8);
            if (tag === 0x9003 || tag === 0x0132) {
              const at = u32(e + 8); let s = "";
              for (let k = 0; k < 19; k++) s += String.fromCharCode(v.getUint8(t + at + k));
              out[tag] = s;
            }
          }
          return out;
        };
        const ifd0 = readIFD(u32(4));
        const sub = ifd0.exif ? readIFD(ifd0.exif) : {};
        const s = sub[0x9003] || ifd0[0x0132];
        const m = s && s.match(/(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
        if (!m) return null;
        const d = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
        return isNaN(d) ? null : d;
      }
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + len;
    }
  } catch (_) { /* not a JPEG with EXIF */ }
  return null;
}

// Shrink to a phone-friendly size and make a thumbnail (keeps storage small).
async function processImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();               // Chrome applies EXIF rotation here
    const make = (max, q) => {
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return new Promise((r) => c.toBlob(r, "image/jpeg", q));
    };
    return { full: await make(2000, 0.86), thumb: await make(360, 0.75) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

let seqCounter = Date.now();
async function photoFromFile(file) {
  const takenAt = (await exifDate(file)) || file.lastModified || Date.now();
  const { full, thumb } = await processImage(file);
  return { blob: full, thumb, takenAt, seq: seqCounter++ };
}

// ------------------------------------------------------------------ ui helpers
const $ = (s) => document.querySelector(s);
const app = $("#app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const go = (hash) => { location.hash = hash; };
const fmtDate = (t) => new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

let objectURLs = [];
function objURL(blob) { const u = URL.createObjectURL(blob); objectURLs.push(u); return u; }
function releaseURLs() { objectURLs.forEach(URL.revokeObjectURL); objectURLs = []; }

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 2600);
}
async function busy(msg, fn) {
  const el = document.createElement("div");
  el.className = "busy"; el.textContent = msg;
  document.body.appendChild(el);
  try { return await fn((m) => { el.textContent = m; }); } finally { el.remove(); }
}
function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function safeName(s) { return String(s).replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "tote"; }

// ------------------------------------------------------------------ photo pickers
// Gallery: pick many at once. Camera: our own burst camera (keep tapping the shutter),
// falling back to Android's camera one shot at a time.
function pickFromGallery(onPhotos) {
  const input = $("#pickGallery");
  input.value = "";
  input.onchange = async () => {
    const files = [...input.files];
    if (!files.length) return;
    const out = await busy("Adding photos…", async (set) => {
      const list = [];
      for (let i = 0; i < files.length; i++) {
        set(`Adding photo ${i + 1} of ${files.length}…`);
        try { list.push(await photoFromFile(files[i])); } catch (_) { /* skip unreadable */ }
      }
      return list;
    });
    if (out.length < files.length) toast(`${files.length - out.length} file(s) couldn't be read`);
    onPhotos(out);
  };
  input.click();
}

function pickFromCameraFallback(onPhotos) {
  const input = $("#pickCamera");
  input.value = "";
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    const p = await busy("Saving photo…", () => photoFromFile(f));
    p.takenAt = Date.now();
    onPhotos([p]);
  };
  input.click();
}

async function openCamera(onPhotos) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    });
  } catch (_) {
    return pickFromCameraFallback(onPhotos);
  }
  const ov = document.createElement("div");
  ov.style.cssText = "position:fixed;inset:0;background:#000;z-index:30;display:flex;flex-direction:column";
  ov.innerHTML = `
    <video playsinline muted autoplay style="flex:1;min-height:0;width:100%;object-fit:cover"></video>
    <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px calc(22px + env(safe-area-inset-bottom))">
      <div style="width:64px;height:64px;position:relative">
        <img id="camLast" style="width:64px;height:64px;border-radius:12px;object-fit:cover;display:none;border:2px solid #fff">
        <span id="camCount" style="position:absolute;right:-8px;top:-8px;background:#2f6f4e;color:#fff;border-radius:14px;padding:2px 8px;font:600 .8rem system-ui;display:none"></span>
      </div>
      <button id="camShutter" aria-label="Take photo" style="width:78px;height:78px;border-radius:50%;border:5px solid #fff;background:rgba(255,255,255,.25)"></button>
      <button id="camDone" style="width:64px;height:44px;border:0;border-radius:12px;background:#fff;color:#2f6f4e;font:700 1rem system-ui">Done</button>
    </div>`;
  document.body.appendChild(ov);
  const video = ov.querySelector("video");
  video.srcObject = stream;
  const track = stream.getVideoTracks()[0];
  const capturer = ("ImageCapture" in window) ? new ImageCapture(track) : null;
  const shots = [];
  let pending = Promise.resolve();

  ov.querySelector("#camShutter").onclick = () => {
    const takenAt = Date.now();
    video.style.opacity = ".3"; setTimeout(() => (video.style.opacity = "1"), 90);
    if (navigator.vibrate) navigator.vibrate(30);
    const grab = (async () => {
      let blob = null;
      if (capturer) { try { blob = await capturer.takePhoto(); } catch (_) { blob = null; } }
      if (!blob) {
        const c = document.createElement("canvas");
        c.width = video.videoWidth; c.height = video.videoHeight;
        c.getContext("2d").drawImage(video, 0, 0);
        blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
      }
      return blob;
    })();
    // process one at a time, in shutter order
    pending = pending.then(async () => {
      const { full, thumb } = await processImage(await grab);
      shots.push({ blob: full, thumb, takenAt, seq: seqCounter++ });
      const last = ov.querySelector("#camLast"), cnt = ov.querySelector("#camCount");
      last.src = URL.createObjectURL(thumb); last.style.display = "block";
      cnt.textContent = shots.length; cnt.style.display = "block";
    }).catch(() => toast("Couldn't take that photo"));
  };
  ov.querySelector("#camDone").onclick = async () => {
    await busy("Saving photos…", () => pending);
    stream.getTracks().forEach((t) => t.stop());
    ov.remove();
    if (shots.length) onPhotos(shots);
  };
}

// ------------------------------------------------------------------ viewer
const viewer = { list: [], i: 0, onDelete: null };
function openViewer(list, i, onDelete) {
  Object.assign(viewer, { list, i, onDelete });
  showViewer();
  $("#viewer").classList.add("on");
}
function showViewer() {
  const p = viewer.list[viewer.i];
  if (!p) return closeViewer();
  const img = $("#vimg");
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  img.dataset.url = URL.createObjectURL(p.blob);
  img.src = img.dataset.url;
  $("#vcount").textContent = `${viewer.i + 1} / ${viewer.list.length}`;
  $("#vcap").textContent = `Taken ${fmtDate(p.takenAt)}`;
}
function closeViewer() { $("#viewer").classList.remove("on"); }
$("#viewer").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "close") closeViewer();
  if (act === "del" && confirm("Delete this photo?")) {
    const [p] = viewer.list.splice(viewer.i, 1);
    await viewer.onDelete?.(p);
    if (!viewer.list.length) return closeViewer();
    viewer.i = Math.min(viewer.i, viewer.list.length - 1);
    showViewer();
  }
});
(() => {
  let x0 = null;
  const stage = $("#viewer .stage");
  stage.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) < 40) return;
    viewer.i = Math.max(0, Math.min(viewer.list.length - 1, viewer.i + (dx < 0 ? 1 : -1)));
    showViewer();
  });
  stage.addEventListener("click", (e) => {     // tap left/right half to step
    const half = e.clientX < window.innerWidth / 2 ? -1 : 1;
    viewer.i = Math.max(0, Math.min(viewer.list.length - 1, viewer.i + half));
    showViewer();
  });
})();
window.addEventListener("popstate", closeViewer);

// ------------------------------------------------------------------ scanner
let scanStream = null, scanLoop = null;
async function openScanner() {
  const sc = $("#scanner"), video = $("#scanvideo");
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
  } catch (_) {
    toast("Camera permission is needed to scan");
    return;
  }
  video.srcObject = scanStream;
  await video.play();
  sc.classList.add("on");

  let detect;
  if ("BarcodeDetector" in window &&
      (await BarcodeDetector.getSupportedFormats?.() || []).includes("qr_code")) {
    const bd = new BarcodeDetector({ formats: ["qr_code"] });
    detect = async () => (await bd.detect(video))[0]?.rawValue;
  } else {
    if (!window.jsQR) await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "lib/jsQR.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
    const c = document.createElement("canvas"), ctx = c.getContext("2d", { willReadFrequently: true });
    detect = async () => {
      const w = 640, h = Math.round(640 * video.videoHeight / video.videoWidth) || 480;
      c.width = w; c.height = h; ctx.drawImage(video, 0, 0, w, h);
      return window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h)?.data;
    };
  }
  const tick = async () => {
    if (!scanStream) return;
    try {
      const text = video.readyState >= 2 ? await detect() : null;
      if (text) return handleScan(text);
    } catch (_) { /* keep trying */ }
    scanLoop = setTimeout(tick, 180);
  };
  tick();
}
function closeScanner() {
  clearTimeout(scanLoop);
  scanStream?.getTracks().forEach((t) => t.stop());
  scanStream = null;
  $("#scanner").classList.remove("on");
}
$("#scanclose").onclick = closeScanner;
async function handleScan(text) {
  closeScanner();
  if (navigator.vibrate) navigator.vibrate(60);
  const m = String(text).match(/[?&#/]tote[=/]([A-Z2-9]{6})/i);
  const id = m && m[1].toUpperCase();
  if (!id) return toast("That QR code isn't a tote sticker");
  if (!(await DB.tote(id))) return toast(`Tote #${id} isn't saved on this phone`);
  go(`#/tote/${id}`);
}

// ------------------------------------------------------------------ sticker
function drawSticker(tote, count) {
  const W = 600, H = 750, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);

  const qr = qrcode(0, "M");
  qr.addData(toteLink(tote.id));
  qr.make();
  const n = qr.getModuleCount(), quiet = 2, size = 520;
  const cell = size / (n + quiet * 2), x0 = (W - size) / 2, y0 = 30;
  g.fillStyle = "#000";
  for (let r = 0; r < n; r++)
    for (let col = 0; col < n; col++)
      if (qr.isDark(r, col))
        g.fillRect(Math.floor(x0 + (col + quiet) * cell), Math.floor(y0 + (r + quiet) * cell),
                   Math.ceil(cell), Math.ceil(cell));

  const centered = (text, y, px, weight) => {
    let s = px;
    do { g.font = `${weight} ${s}px system-ui, Roboto, sans-serif`; s -= 2; }
    while (g.measureText(text).width > W - 48 && s > 14);
    g.fillStyle = "#000"; g.textAlign = "center"; g.textBaseline = "alphabetic";
    g.fillText(text, W / 2, y);
  };
  centered(tote.name, 605, 46, 700);
  centered(`#${tote.id}  ·  ${plural(count, "item")}`, 655, 28, 400);
  centered("Scan to see what's inside", 700, 24, 400);
  g.strokeStyle = "#bbb"; g.lineWidth = 3;
  g.beginPath(); g.roundRect(3, 3, W - 6, H - 6, 24); g.stroke();
  return c;
}

// ------------------------------------------------------------------ screens
async function screenHome() {
  const totes = await DB.totes();
  if (!totes.length) {
    app.innerHTML = `
      <div class="hero">
        <img src="icons/icon-192.png" alt="">
        <h2>Tote QR</h2>
        <p class="muted">Photograph what goes in a tote, print its QR sticker, and scan it any time to see inside without opening it.</p>
      </div>
      <div class="stack">
        <button class="btn" id="first">＋ Create your first tote</button>
        <button class="btn light" id="scan">Scan a tote's QR</button>
      </div>`;
    $("#first").onclick = () => go("#/new");
    $("#scan").onclick = openScanner;
    return;
  }
  const counts = await Promise.all(totes.map((t) => DB.photos(t.id)));
  app.innerHTML = `
    <header class="bar"><h1>Your totes</h1><span class="muted small">${plural(totes.length, "tote")}</span></header>
    <div id="list"></div>
    <div class="fab">
      <button class="btn light" id="scan">Scan QR</button>
      <button class="btn" id="new">＋ New tote</button>
    </div>`;
  const list = $("#list");
  totes.forEach((t, i) => {
    const photos = counts[i];
    const a = document.createElement("a");
    a.className = "tote"; a.href = `#/tote/${t.id}`;
    const th = photos[0] ? `style="background-image:url(${objURL(photos[0].thumb)})"` : "";
    a.innerHTML = `<div class="th" ${th}></div>
      <div><b>${esc(t.name)}</b><span class="muted small">#${t.id} · ${plural(photos.length, "item")}</span></div>`;
    list.appendChild(a);
  });
  $("#scan").onclick = openScanner;
  $("#new").onclick = () => go("#/new");
}

// New-tote flow: 1) add photos  2) name it  3) save → QR sticker
let draft = null;
async function screenNew() {
  draft = draft || { photos: [], name: "" };
  const renderGrid = () => {
    sortTaken(draft.photos);
    const grid = $("#grid");
    if (!draft.photos.length) {
      grid.className = "empty muted";
      grid.innerHTML = "No photos yet — take or pick photos of the products going into this tote.";
    } else {
      grid.className = "grid";
      grid.innerHTML = draft.photos.map((p, i) =>
        `<div class="ph"><img src="${objURL(p.thumb)}"><span>${i + 1}</span>
         <button data-rm="${i}" aria-label="Remove">✕</button></div>`).join("");
    }
    $("#count").textContent = draft.photos.length ? `(${draft.photos.length})` : "";
    $("#save").disabled = !draft.name.trim();
  };
  const add = (ps) => { draft.photos.push(...ps); renderGrid(); };

  app.innerHTML = `
    <header class="bar"><button class="iconbtn" id="back">←</button><h1>New tote</h1></header>
    <label class="step">1 · Add photos <span class="muted" id="count"></span></label>
    <div class="row2">
      <button class="btn" id="cam">📷 Take photos</button>
      <button class="btn light" id="gal">🖼 From gallery</button>
    </div>
    <div id="grid" style="margin-top:12px"></div>
    <label class="step" for="name">2 · Name it</label>
    <input type="text" id="name" placeholder="e.g. Winter clothes, Bin A3, Kitchen extras" maxlength="60"
           autocomplete="off" enterkeyhint="done">
    <div style="margin-top:22px"><button class="btn" id="save" disabled>3 · Save &amp; make QR sticker</button></div>`;
  $("#name").value = draft.name;
  $("#name").oninput = (e) => { draft.name = e.target.value; $("#save").disabled = !draft.name.trim(); };
  $("#back").onclick = () => {
    if (draft.photos.length && !confirm("Discard this tote?")) return;
    draft = null; go("#/");
  };
  $("#cam").onclick = () => openCamera(add);
  $("#gal").onclick = () => pickFromGallery(add);
  $("#grid").onclick = (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) { draft.photos.splice(+rm.dataset.rm, 1); renderGrid(); return; }
    const ph = e.target.closest(".ph");
    if (ph) openViewer(draft.photos, [...ph.parentNode.children].indexOf(ph), () => renderGrid());
  };
  $("#save").onclick = async () => {
    const id = await newToteId(), now = Date.now();
    await busy("Saving tote…", async () => {
      await DB.putTote({ id, name: draft.name.trim(), createdAt: now, updatedAt: now });
      for (const p of draft.photos) await DB.addPhoto({ ...p, toteId: id });
    });
    navigator.storage?.persist?.();   // ask Android not to clear our storage
    draft = null;
    go(`#/sticker/${id}`);
  };
  renderGrid();
}

async function screenTote(id) {
  const tote = await DB.tote(id);
  if (!tote) {
    app.innerHTML = `<header class="bar"><button class="iconbtn" id="back">←</button><h1>Not found</h1></header>
      <div class="card">Tote <b>#${esc(id)}</b> isn't saved on this phone.
      Totes live on the phone that created them.</div>`;
    $("#back").onclick = () => go("#/");
    return;
  }
  const photos = await DB.photos(id);
  app.innerHTML = `
    <header class="bar"><button class="iconbtn" id="back">←</button>
      <h1>${esc(tote.name)}</h1><button class="iconbtn" id="rename" aria-label="Rename">✎</button></header>
    <p class="muted small" style="margin-top:-6px">#${tote.id} · ${plural(photos.length, "item")} · in the order taken</p>
    <div class="row2">
      <button class="btn" id="cam">📷 Take photos</button>
      <button class="btn light" id="gal">🖼 From gallery</button>
    </div>
    <div id="grid" style="margin-top:12px"></div>
    <div class="stack" style="margin-top:22px">
      <button class="btn danger" id="del">Delete tote</button>
    </div>
    <div class="fab">
      <button class="btn light" id="export">Save to phone</button>
      <button class="btn" id="qr">QR sticker</button>
    </div>`;
  const grid = $("#grid");
  if (!photos.length) {
    grid.className = "empty muted"; grid.textContent = "No photos in this tote yet.";
  } else {
    grid.className = "grid";
    grid.innerHTML = photos.map((p, i) =>
      `<div class="ph" data-i="${i}"><img src="${objURL(p.thumb)}" loading="lazy"><span>${i + 1}</span></div>`).join("");
    grid.onclick = (e) => {
      const ph = e.target.closest(".ph");
      if (ph) openViewer(photos, +ph.dataset.i, async (p) => { await DB.deletePhoto(p.id); await DB.touch(id); render(); });
    };
  }
  const addAndSave = async (ps) => {
    await busy("Saving…", async () => { for (const p of ps) await DB.addPhoto({ ...p, toteId: id }); });
    await DB.touch(id);
    toast(`Added ${plural(ps.length, "photo")}`);
    render();
  };
  $("#back").onclick = () => go("#/");
  $("#cam").onclick = () => openCamera(addAndSave);
  $("#gal").onclick = () => pickFromGallery(addAndSave);
  $("#qr").onclick = () => go(`#/sticker/${id}`);
  $("#rename").onclick = async () => {
    const name = prompt("Tote name", tote.name);
    if (name && name.trim()) { tote.name = name.trim().slice(0, 60); tote.updatedAt = Date.now(); await DB.putTote(tote); render(); }
  };
  $("#del").onclick = async () => {
    if (!confirm(`Delete "${tote.name}" and its ${plural(photos.length, "photo")}? Its sticker will stop working.`)) return;
    await DB.deleteTote(id); go("#/");
  };
  $("#export").onclick = () => exportZip(tote, photos);
}

// "Save to phone": a .zip with a folder named after the tote, photos numbered in order taken
async function exportZip(tote, photos) {
  if (!photos.length) return toast("No photos to save");
  const blob = await busy("Packing photos…", async () => {
    const folder = `${safeName(tote.name)}_${tote.id}`, files = {};
    for (let i = 0; i < photos.length; i++) {
      const d = new Date(photos[i].takenAt);
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      files[`${folder}/${String(i + 1).padStart(3, "0")}_${stamp}.jpg`] =
        [new Uint8Array(await photos[i].blob.arrayBuffer()), { level: 0 }];
    }
    const sticker = drawSticker(tote, photos.length);
    const png = await new Promise((r) => sticker.toBlob(r, "image/png"));
    files[`${folder}/_QR-sticker.png`] = [new Uint8Array(await png.arrayBuffer()), { level: 0 }];
    return new Blob([fflate.zipSync(files)], { type: "application/zip" });
  });
  downloadBlob(blob, `${safeName(tote.name)}_${tote.id}.zip`);
  toast("Saved to Downloads");
}

async function screenSticker(id) {
  const tote = await DB.tote(id);
  if (!tote) return go("#/");
  const count = (await DB.photos(id)).length;
  const canvas = drawSticker(tote, count);
  const link = toteLink(id);
  app.innerHTML = `
    <header class="bar"><button class="iconbtn" id="back">←</button><h1>QR sticker</h1></header>
    <img id="sticker" alt="QR sticker for ${esc(tote.name)}">
    <p class="muted small" style="text-align:center;word-break:break-all">Opens: ${esc(link)}</p>
    <div class="stack">
      <button class="btn" id="share">Share / save sticker image</button>
      <button class="btn light" id="print">Print</button>
      <button class="btn light" id="done">Done — open tote</button>
    </div>`;
  $("#sticker").src = canvas.toDataURL("image/png");
  $("#back").onclick = $("#done").onclick = () => go(`#/tote/${id}`);
  $("#print").onclick = () => window.print();
  $("#share").onclick = async () => {
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    const file = new File([blob], `tote-${id}-sticker.png`, { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: `${tote.name} QR sticker` }); return; }
      catch (e) { if (e.name === "AbortError") return; }
    }
    downloadBlob(blob, file.name);
    toast("Saved to Downloads");
  };
}

// ------------------------------------------------------------------ router
async function render() {
  releaseURLs();
  const h = location.hash.replace(/^#/, "") || "/";
  const [, page, id] = h.split("/");
  if (!page) return screenHome();
  if (page === "new") return screenNew();
  if (page === "tote") return screenTote(id.toUpperCase());
  if (page === "sticker") return screenSticker(id.toUpperCase());
  go("#/");
}
window.addEventListener("hashchange", render);

// A scanned sticker opens .../?tote=ID → jump to that tote
(() => {
  const t = new URLSearchParams(location.search).get("tote");
  if (t) history.replaceState(null, "", `${location.pathname}#/tote/${t.toUpperCase()}`);
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
