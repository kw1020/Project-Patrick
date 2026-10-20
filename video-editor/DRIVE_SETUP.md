# Connect Patrick to Google Drive

**What you get:** drop a video in a Drive folder (from your phone, or a school computer) and Patrick edits it.
The finished video appears as `<name> [edited].mp4` in your **finished folder** (or beside the original if you
don't set one), and Patrick **emails you** when each one is done (if the email settings are filled in). Put instructions in the file name:

```
zoomies mute music: chill trim 0:03-0:15.mp4
```
(`dog only`, `gentle`, `strict`, `keep audio`, `mute`, `denoise`, `music: name`, `trim a-b`, `speed 1.5`, `crop`.
Same words as the email version.) No instructions = people talking are removed and your dog's sounds kept.
Beside the video you also get `<name> [notes].txt` saying what was done (e.g. how many seconds of talking were removed).
If something fails you get `<name> [error].txt`.
It checks the folder every 30 seconds and never deletes or overwrites anything.

> Not tested against real Google Drive yet (only against a fake Drive). Expect to fix a snag or two on first run.

## One-time setup (~15 min, easiest on a computer)

Use the **dedicated Patrick Google account**, not your personal one. The app gets that account's Drive
access, so if the key ever leaks only the shared folder is exposed, not all of your Drive.

1. **Make the folders.** In *your* Drive, make one folder to drop videos into (e.g. `Ghost vids`) and one for results
   (e.g. `Finished Videos`). **Share both with the Patrick Gmail as Editor.**
   Open each folder; its **folder ID** is the end of the address: `drive.google.com/drive/folders/THIS_PART`.
2. **Google Cloud** (console.cloud.google.com, signed in as the Patrick account):
   1. Create a project (any name).
   2. APIs & Services → Library → enable **Google Drive API**.
   3. OAuth consent screen → *External* → fill in the app name and your email → add the Patrick account as a test user → **Publish app** (to "In production").
      If you leave it in "Testing", Google expires the login after 7 days.
   4. Credentials → Create credentials → **OAuth client ID** → type **Web application** → add this *Authorized redirect URI*:
      `https://developers.google.com/oauthplayground` → copy the **Client ID** and **Client secret**.
3. **Get the refresh token** at developers.google.com/oauthplayground (works in a phone browser):
   1. Gear icon → tick **Use your own OAuth credentials** → paste the Client ID and secret.
   2. In the left list type the scope `https://www.googleapis.com/auth/drive` → **Authorize APIs** → sign in as the Patrick account.
      Google warns the app is unverified: **Advanced → Go to (app) → Allow**. That's expected for your own app.
   3. **Exchange authorization code for tokens** → copy the **Refresh token**.
4. **Give Render the values** (Dashboard → your service → Environment):
   `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN`, `GDRIVE_FOLDER_ID` (the drop folder) and
   `GDRIVE_OUTPUT_FOLDER_ID` (the finished folder; use **Add Environment Variable**, it isn't pre-listed). It restarts and starts watching.
5. **For the "it's done" emails**, also fill in `EMAIL_ADDRESS` (the Patrick Gmail), `EMAIL_APP_PASSWORD` (that account's
   16-letter App Password; Google Account → Security → 2-Step Verification → App passwords) and `ALLOWED_SENDERS` (your own address;
   the notices go there). No email settings = the videos still get edited, you just don't get told.

Google's menu names change now and then; if a step looks different, tell me what you see and I'll adjust.

## Notes
- A free Render instance sleeps after 15 idle minutes, which pauses the watcher (see README for keeping it awake).
- Files over 500 MB are skipped with an `[error]` note (`DRIVE_MAX_MB` changes the limit).
- To redo a video, rename it. Patrick treats a renamed file as new.
