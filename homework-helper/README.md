# Patrick

Patrick's first paid product. Students type a question or snap a photo of their homework (math, reading, science, anything), and Patrick does it and hands back finished answers, with the work shown.

## Use it on your PC (easiest)

1. Download Patrick: https://github.com/kw1020/Project-Patrick/archive/refs/heads/claude/nifty-bardeen-krms1l.zip and unzip it.
2. Open the `homework-helper` folder and double-click **Start Patrick.bat** (on a Mac: **Start Patrick.command**).
   - The first time, it opens the Node.js download page if you need it, then sets itself up.
3. Patrick opens in your browser. Click **⚙️** (or **Open Settings**), paste your Anthropic API key and (optionally) your Canvas address + token, and click **Save**. Patrick checks the key before saving it. Keep the black window open while you use him; close it to stop him.
4. **Make it a real desktop app:** in Chrome or Edge, click the install icon at the right end of the address bar (or ⋮ → "Install Patrick"). He gets his own window and a desktop/Start menu icon. After that, double-click **Start Patrick** first, then open the app.

Keys are saved only on your computer (in `data/settings.json`). To change a key, such as when it expires, paste the new one in Settings. Settings only works on the computer running Patrick, so customers on a hosted copy can't see or change your keys.

## Run it (developers)

1. Get an Anthropic API key at https://console.anthropic.com (add about $10 of credit to start).
2. Install and start:
   ```bash
   npm install
   ANTHROPIC_API_KEY=sk-ant-... PATRICK_ACCESS_CODES=customer1-code npm start
   ```
3. Open http://localhost:3000

No API key yet? Leave out `ANTHROPIC_API_KEY` and Patrick runs in **demo mode**, sending a sample math answer so you can try the app.

`PATRICK_ACCESS_CODES` is a comma-separated list. Give each paying customer their own code, and remove a code if they stop paying.

## Using it

- **Install it as an app:** open the site on a phone. On iPhone, tap Share → "Add to Home Screen". On Android, tap ⋮ → "Install app". Patrick gets his own icon and opens full screen like a normal app.
- **Turning in the work:** under every answer there's **📋 Copy** (paste anywhere), **🖨️ Print / PDF** (a clean answer sheet with a Name and Date line), and **📄 Google Doc / Word** (downloads a file that opens in Word or uploads to Google Docs).

## Canvas: do assignments straight from Canvas

Tap **📚 Get homework from Canvas**, enter the school's Canvas address and a Canvas access token, then tap **Load my assignments**. Missing work shows first. Tap **Do it** on an assignment and Patrick:

1. Reads the assignment instructions on Canvas (like "1.1: problems 1–20 odd, column A").
2. Opens everything the assignment links to: Canvas files and pages, the teacher's website (including pictures on it), and Google Docs/Drive links.
3. Does exactly the problems the instructions list, numbered to match, so you can write them on paper.

**Getting a token (no password needed):** Canvas → Account → Settings → Approved Integrations → **+ New Access Token**. The token stays only in the student's browser and is never stored on the server. You can delete the token in Canvas anytime.

**Limits:**
- Some schools turn off student tokens. If the button is missing, use photos instead.
- If the teacher's website needs its own login, Patrick says so. Screenshot that page and add it as a photo.
- Patrick only reads. It never submits anything to Canvas.

## Stopping sharing

- **Never send customers the files.** They only get the website link and their code, so there's nothing for them to copy.
- **One code = one device.** The first phone or computer that uses a code gets locked to it. If a friend tries the same code, they're blocked.
- **Daily limit.** Each code gets `PATRICK_DAILY_LIMIT` questions a day (default 40), which keeps your API bill safe.
- **Customer got a new phone or cleared their browser?** Unlock their code, and their next device gets locked in:
  ```bash
  npm run reset-code -- customer1-code
  ```

## Put it online (so the customer can use it on their phone)

Deploy this folder to Render, Railway, or Fly.io as a Node web service:
- Start command: `npm start`
- Environment variables: `ANTHROPIC_API_KEY`, `PATRICK_ACCESS_CODES`, and optionally `PATRICK_DAILY_LIMIT`
- Add a persistent disk and set `DATA_DIR` to its path. Otherwise the device locks reset every time the site redeploys.

## Costs

Each question costs a few cents in API fees, so one student pays roughly $2–8 a month. At $50 a month per student, most of that is profit.
