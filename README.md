# SRG Card Scanner

Phone web app that reads SRG Supershow card names with OCR and logs them to the
Count Log tab of your inventory sheet. Static site (HTML/CSS/JS) + one Apps Script file.

## Files

| File | What it does |
|---|---|
| `apps-script/Code.gs` | The bridge. Paste into the sheet's Apps Script editor. |
| `index.html`, `css/app.css` | The page and its look. |
| `js/app.js` | Wires everything: buttons, read flow, picker, session panel. |
| `js/camera.js` | Starts the rear camera; crops + cleans the name box for OCR. |
| `js/ocr.js` | Tesseract.js wrapper (runs in its own Web Worker). |
| `js/detector.js` | Detects a new *physical* card: motion, then stillness. |
| `js/matcher.js` | Normalizes text and fuzzy-matches (Levenshtein) against your list. |
| `js/boxEditor.js` | Draggable/resizable boxes over the camera feed. |
| `js/storage.js` | IndexedDB: cached card list, settings, boxes, local entry queue. |
| `js/sync.js` | Offline-first queue: sends in batches of 10, retries safely. |
| `js/api.js` | `fetch` calls to the Apps Script web app. |
| `test/matcher.test.mjs` | Matcher tests: `npm test` |
| `tools/serve.mjs` | Local server for desktop testing: `node tools/serve.mjs` |

No spreadsheet ID, URL or token lives in this repo. The script is bound to the
sheet, and the URL + token are typed into the app's Setup tab on your phone
(stored only on the phone). `js/config.js` is an optional local shortcut and is gitignored.

---

## Part 1: Deploy the Apps Script bridge (about 10 minutes)

### 1. Paste the code
1. Open the spreadsheet.
2. **Extensions → Apps Script.** A new tab opens with a file called `Code.gs`.
3. Delete everything in `Code.gs`. Paste in the full contents of `apps-script/Code.gs`.
4. Click the project name at the top ("Untitled project") and rename it `SRG Scanner Bridge`.
5. Press **Ctrl+S** to save.

### 2. Create the token (this triggers the one-time approval screen)
1. In the toolbar, open the function dropdown (next to **Debug**) and pick `createToken`.
2. Click **Run**.
3. **"Authorization required"** pops up → click **Review permissions**.
4. Pick your Google account.
5. **"Google hasn't verified this app"** appears. This is normal for a script you wrote yourself.
   Click **Advanced** (small link, bottom left) → **Go to SRG Scanner Bridge (unsafe)**.
6. The next screen lists what the script can do ("See, edit, create and delete your spreadsheets…").
   Click **Allow**. (If you see checkboxes, tick them all.)
7. The **Execution log** opens at the bottom and shows `Your token: 3f9a…`. Copy that token somewhere private.
   You can see it again any time under ⚙ **Project Settings → Script Properties → TOKEN**.

### 3. Deploy as a web app
1. Top right: **Deploy → New deployment**.
2. Click the ⚙ next to "Select type" → **Web app**.
3. Description: `v1`.
4. **Execute as: Me**.
5. **Who has access: Anyone**. (The token is what keeps strangers out.)
6. Click **Deploy**. If it asks for authorization again, repeat the steps from 2.3.
7. Copy the **Web app URL**. It ends in `/exec`.

### 4. Test it from a terminal (Git Bash)
Replace `URL` and `TOKEN` with yours.

Read the card list (should print JSON starting with `{"ok":true,"cards":[`):
```bash
curl -sL "URL?token=TOKEN" | head -c 300
```

Append one test row (`-L` follows Google's redirect; prints the row number used):
```bash
curl -sL -H "Content-Type: text/plain" -d '{"token":"TOKEN","action":"append","batchId":"test-1","entries":[{"name":"Chop Down","foil":"","count":1,"date":"2026-11-15","notes":"TEST"}]}' "URL"
```

Check the sheet: Count Log has the row, and column E says `OK`. Then remove it
(put the row number from the previous reply in place of `2`):
```bash
curl -sL -H "Content-Type: text/plain" -d '{"token":"TOKEN","action":"undo","row":2,"name":"Chop Down"}' "URL"
```

A wrong token returns `{"ok":false,"error":"Bad token"}`.

### Updating the script later
Editing `Code.gs` does **not** change the live web app. After an edit:
**Deploy → Manage deployments → ✏ (pencil) → Version: New version → Deploy.**
This keeps the same URL. ("New deployment" would make a new URL.)

---

## Part 2: Put the app on your phone

The camera only works on HTTPS. GitHub Pages gives you HTTPS for free.

1. Create a GitHub repo (free Pages needs it to be **public**; nothing secret is in it).
2. Push this folder to it.
3. Repo **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**.
4. After about a minute, open `https://<your-user>.github.io/<repo>/` on the phone.
5. Open the **Setup** tab, paste the **Web app URL** and **token**, tap **Save settings**. The top bar shows the number of names loaded.
6. Optional: browser menu → **Add to Home screen**.

**Desktop testing:** `node tools/serve.mjs`, then open `http://localhost:8080`
(localhost counts as secure, so the webcam works).

---

## Using it

Three tabs at the bottom:
- **Scan**: camera, the Normal/FOIL switch, Start/Stop camera, Read now, Read from a photo. The banner over the camera shows the last logged card and the session count (green = just logged, amber = picker open).
- **Log**: session name, total, Undo last card, Sync now, Clear list, and the list of cards.
- **Setup**: the card box (calibration) and all settings, with **Save settings**.

The camera keeps reading while you look at **Log**, and the picker pops up on any tab.

### Card box (calibration, once per rig)
1. **Scan** tab → **Start camera**, put a card on the rig.
2. **Setup** tab. Drag the yellow box so it lines up with the **outer edge of the whole card**; drag the round corner handle to resize. It saves on release.
3. **Try a test read**. A green box shows where the name was found, a cyan box the `#NN` number. The strip next to "OCR saw" is exactly what Tesseract read.
   These two boxes only show here; they're markers, not something you move.

You don't set boxes per card. Names and numbers sit in different places on
different card designs, so the app slides a thin strip over the top of the
card (name) and the bottom-right corner (number) and keeps the spot that reads
as a real card name. It tries the spot that worked last time first, so most
cards take 1–2 OCR passes.

Stacked titles (one name printed on 2–3 lines) are read one line per strip,
then the lines are joined top to bottom and matched as one name
(`js/lines.js`). If a single line matches a name that also sits inside a
longer name (e.g. "Sledgehammer"), the app reads the lines around it before
logging, so one line of a long title can't log the wrong card.

Skill icon (`js/skill.js`): about 11 card groups share a name and deck and
differ only by the skill in brackets ("Bow to None (Grapple / Power /
Strike)"). For those, the app checks the bottom-left icon's color
(red Power, orange Technique, yellow Strike, green Agility, blue Grapple,
purple Submission) and puts its guess first in the picker. It never logs one
of these on its own: on test scans the color guess was wrong about 2 times in 300.

Why not one big box? Tesseract only reads well when the crop hugs a single
line of text. On rig photos, a box that also held the border or the
"LEAD / GRAPPLE" label read nothing at all.

### Live scanning
- **Start camera** and crank. The meter shows: *card moving…* → *ready* → read → *waiting for next card*.
- Each card is read once after it stops moving for `stableMs` (default 350 ms). Three copies in a row = three entries, because each one moves in.
- **Confident match** → high beep + green flash, logged.
- **Not sure** → low beep, the picker opens with the top 3 + a search box. Stop cranking, tap the right one (or **Skip this card** / **Read again**).
- **Read now** forces a read of whatever is under the camera.

### Read from a photo
On **Scan**, tap **Read from a photo** → **Take photo** → drag the yellow box around the whole card → **Read card**. **← Back to live camera** returns to the camera.

### Foil, session, undo, sync (Log tab)
- **Scanning: Normal cards / FOIL cards** button (Scan tab): when it says FOIL (purple frame), every entry gets Foil = `Yes`.
- **Session name** goes into Notes (e.g. `Box 2`). The list and total show that session. Change the name to start a new one; change it back to resume.
- **Undo last card**: unsent entry → deleted on the phone. Sent entry → its row is cleared in Count Log (only A, B, C, F, G; the script checks the name first).
- **Sync**: entries save on the phone first. They send automatically every 10 cards, every minute, and when Wi-Fi returns. The chip shows `N waiting` / `synced 14:32`. Tap it to send now.
  Retries reuse a batch ID, so a lost reply never writes the same rows twice.
- **Clear list**: removes this session's cards from the list on the phone only. The sheet stays the same. Cards not sent yet get a second warning.

---

## Tuning (Setup tab)

| Setting | Default | Raise it when… | Lower it when… |
|---|---|---|---|
| Auto-accept score | 0.85 | wrong cards get auto-logged | the picker opens too often for clear reads |
| Required lead over #2 | 0.08 | similar names get mixed up | — |
| Still time (ms) | 350 | cards are read while still sliding | the crank feels slowed down |
| Motion level | 12 | the meter jumps to *moving* with no card change (vibration) | card changes are missed |
| Below this = still | 4 | the card never counts as still (flicker, shaky rig) | reads happen mid-motion |

The motion number ignores small per-pixel changes (`SMALL_CHANGE` in
`js/detector.js`), so foil shine shifting as you move doesn't count as a card
moving. A large glare sweep still can: if a foil never reads, angle the light.

Lighting matters most: steady, diffuse light from the side, no glare on foils.

---

## How the pieces fit

```
camera ─▶ detector (motion → still) ─▶ crop name box ─▶ grayscale/contrast/upscale
        ─▶ Tesseract (worker) ─▶ normalize ─▶ Levenshtein vs ~6,000 names
        ─▶ confident? ── yes ─▶ IndexedDB queue ─▶ batch POST ─▶ Apps Script ─▶ Count Log
                      └─ no ──▶ picker (top 3 / search / skip)
```

Matching details (`js/matcher.js`):
- Both sides are normalized: lower case, `?!*'--` removed, spaces collapsed. `*Snap*` → `snap`.
- OCR slips in version tags are fixed: `(VI)`, `(Vl)`, `(V|)` → `v1`.
- If OCR reads `v1` and the candidate is `v2`, that candidate is penalized.
- If OCR misses the tag entirely, V1 and V2 tie, so the picker asks you.

## Testing checklist (from the brief)
- [ ] 20 regular cards incl. 3 copies of one card in a row → 3 entries
- [ ] `Pineapple for Sheep?`, `*Snap*`, `Did It Better!`
- [ ] `Impact is Family (V1)` / `(V2)`
- [ ] Foil batch with "Scanning: FOIL cards" on
- [ ] Undo; turn Wi-Fi off mid-session, keep scanning, turn it back on
- [ ] Count Log column E reads `OK` for every row; card tabs' Quantity Owned went up
