# Krew's Terraria Wiki Skin

Makes the official Terraria Wiki (terraria.wiki.gg) look the way Krew wants:

- Dark cavern-blue theme with torch-amber links
- Clean, readable fonts and wider spacing
- Sidebar hidden by default (tap **Menu** to bring it back)
- Item and boss info boxes, recipe tables and drop tables restyled as clean cards
- Ads, edit links and other clutter hidden
- Press `/` anywhere to jump to the search box
- **Original look** button turns the skin off; tap **Krew skin** to turn it back on

It works on every wiki page and stays up to date, because it restyles the real wiki in your own browser.

## Install

### Computer (Chrome, Edge, Firefox, Brave)
1. Install the free **Tampermonkey** or **Violentmonkey** extension.
2. Click the extension icon, then **Create a new script**.
3. Delete what's there, paste in everything from `krew-terraria-wiki.user.js`, and save.
4. Open https://terraria.wiki.gg

Chrome and Edge may ask you to turn on **Developer mode** (or "Allow user scripts") for the extension the first time.

### iPhone / iPad
1. Install the free **Userscripts** app from the App Store.
2. In Settings → Safari → Extensions, turn on **Userscripts** and allow it on terraria.wiki.gg.
3. Open the Userscripts app, set a folder, then add a new script and paste in the file.
4. Open https://terraria.wiki.gg in Safari.

### Android
1. Install **Firefox** for Android.
2. In Firefox, add the **Tampermonkey** extension.
3. Create a new script and paste in the file, same as on a computer.

## Change colors
The colors are at the top of the file, in the `html.krew { ... }` block (`--k-bg`, `--k-accent`, and so on). Change a value, save, and reload the wiki.
