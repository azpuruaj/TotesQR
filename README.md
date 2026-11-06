# Tote QR

An offline Android app for keeping track of what's inside your totes:

1. **Create a tote**, take photos of the products as they go in (or pick them from the gallery), and name it.
2. **Make its QR sticker**, then print it or save it as an image.
3. **Scan the sticker** to open that tote, with its photos shown in the order they were taken.

All photos stay on the phone. Nothing is uploaded anywhere.

## Getting it onto your phone (one-time)

Android only installs web apps from an `https://` address, so the folder needs a free home online.
GitHub Pages is a good choice because it's permanent:

1. Create a free account at github.com, then create a **new public repository** (for example `TotesQR`).
2. Click **"uploading an existing file"**, drag in **everything inside this folder**
   (`index.html`, `app.js`, `sw.js`, `manifest.webmanifest`, and the `lib` and `icons` folders),
   then click **Commit**.
3. Go to **Settings → Pages**, set Source to **Deploy from a branch** with branch **main** and folder **/ (root)**, then click **Save**.
4. After about a minute your app is live at `https://azpuruaj.github.io/TotesQR/`.
5. Open that address in **Chrome on your Android phone**, tap **⋮ → Add to Home screen → Install**.

From then on it opens like a normal app and works with no internet.

> ⚠️ Every QR sticker contains the app's address. Choose the address before you print stickers.
> If you move the app to a different address later, the old stickers won't open it.

## Things to know
- **Totes are saved on the phone that made them.** If another phone scans the sticker, it shows
  "not saved on this phone".
- **Back up** a tote with **Save to phone**. It downloads a zip to Downloads, containing a folder
  of the photos numbered in the order taken, plus the sticker.
- **Photo order:** photos taken in the app are ordered by when you pressed the shutter. Photos
  picked from the gallery are ordered by the capture date stored in the photo itself.
- Android may ask to keep the app's storage. Allow it, so the system never clears your photos.

## Files
| File | What it does |
|---|---|
| `index.html` | Screens and styling |
| `app.js` | All app logic: storage, camera, QR sticker, scanner, export |
| `sw.js` | Makes it work offline |
| `manifest.webmanifest` | Makes it installable (name, icon, colors) |
| `lib/` | QR code maker (qrcode-generator), QR reader (jsQR), and zip maker (fflate) |
