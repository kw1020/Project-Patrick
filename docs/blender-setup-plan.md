# Blender + Connectors Setup Plan

Goal: get Krew producing good Minecraft "Video Games Explain the Real World"
shorts in Blender this week, with Claude connected to as much of the pipeline
as possible. Research done 2026-09-29; re-check versions before installing.

---

## 1. The stack at a glance

| Step | Tool | Connected to Claude? |
|---|---|---|
| Trend + topic research | **vidIQ** | ✅ Connector (Claude directory) |
| Script, fact check, shot list | Claude | ✅ Built in |
| Record Minecraft scenes | **Flashback** mod (or Replay Mod) | ❌ Manual — Krew plays |
| Bring world into Blender | **Mineways** or **jmc2obj** + **MCprep** add-on | Via Blender connector |
| Characters | **Boxscape Studios rig pack** / DigitalDan Simple Player Rig / Thomas Rig Legacy; our own mascot built in **Blockbench** | Via Blender connector |
| Scene, camera, lighting, render setup | **Blender 5.2 LTS** | ✅ **Official Blender connector** |
| Character acting | Keyframe by hand, or AI mocap (**QuickMagic**, **Rokoko Vision**) + cleanup in **Cascadeur** | ❌ Web tools |
| Voice | **ElevenLabs** | ✅ Hosted MCP |
| Lip sync | **Rhubarb Lipsync NG** / **LipKit** Blender add-ons | Via Blender connector |
| Music + sound effects | **Epidemic Sound** (licensed) or ElevenLabs sound effects | ✅ Connector (Claude directory) |
| Captions, charts, arrows, numbers | **Remotion** + Remotion agent skills in Claude Code | ✅ Claude Code skill |
| Real-world cutaways (not game characters) | AI video: **Kling 3.0** (value), **Veo 3.1** (with audio), **Runway Gen-4.5** (most control) | ❌ Web tools / API later |
| Thumbnails / cover frames / resizing | **Canva** or **Adobe for creativity** | ✅ Connectors |
| Content board + clip library | **Notion** or **Google Sheets**, **Google Drive** or **Dropbox** | ✅ Connectors |
| Posting | **Metricool** or **Buffer** at first → platform APIs later | ❌ Manual/scheduler at first |

---

## 2. Connectors to hook up (ranked)

### Must-have

1. **Blender (official)** — Launched by Anthropic + the Blender team on
   2026-04-28. Built on Blender Lab's official MCP server (free, GPL).
   - **Requires Blender 5.1 or newer** → install **Blender 5.2 LTS**.
   - **Runs on Krew's computer through the Claude Desktop app.** A cloud
     session like this one can't reach Blender on your PC.
   - Setup:
     1. In Claude Desktop: **Customize → Connectors → search "Blender" → Add**.
     2. Open the Blender MCP Server page (blender.org/lab/mcp-server). Drag the
        install link into Blender **twice**: once to add the Blender Lab
        extension repository, once to install the add-on.
     3. In Blender, enable the add-on and start the MCP server. Claude now
        sees your scene.
   - **Good at:** reading and explaining scenes, building sets, placing and
     animating cameras, lighting, simple keyframes, render settings, batch
     scripts (for example "set every scene to 1080×1920, EEVEE, 30fps"), and
     adding custom buttons/tools to Blender.
   - **Weak at:** character rigging (IK, weight painting) and big node setups.
     → Use ready-made rigs, and let Claude do the scene, camera and batch work.
   - **Safety:** it runs Python that Claude writes inside Blender. **Save
     before every request**, and keep backups. Only run one Blender MCP server
     at a time.
   - Optional alternative: the community **MCP for Blender** (ahujasid,
     ~29k GitHub stars). It adds Poly Haven, Sketchfab and AI 3D model
     generation, and works with older Blender. Use it only if we need those
     asset features, and never at the same time as the official one.

2. **ElevenLabs** — Voice for the host character, plus sound effects and
   music from text. As of 2026-08-22 the recommended setup is the **hosted
   MCP** at `https://api.elevenlabs.io/v1/mcp`. You sign in with your
   ElevenLabs account, with no install or API key. (The "ElevenLabs" listing
   in Claude's directory is for managing voice agents, which is a different
   thing.)

3. **Epidemic Sound** — In Claude's connector directory since 2026-08-31.
   Search 300k+ tracks and 250k+ sound effects from chat, filtered by mood,
   BPM and length. All licensed. Needs an Epidemic Sound subscription.

4. **vidIQ** — In Claude's directory. It provides keyword research, trending
   videos, outlier videos and channel stats across YouTube, Instagram and
   TikTok. This is the **Trend Scout's** data source.

### Nice-to-have

5. **Notion** or **Google Sheets** — content board (open question).
6. **Google Drive** or **Dropbox** — clip library, renders, project files.
7. **Canva** or **Adobe for creativity** — thumbnails and cover frames. Adobe
   also resizes and does light social animation. It works at Adobe Express
   level, not a full Premiere timeline.

### Claude Code skill (not a connector)

8. **Remotion agent skills** — lets Claude Code build the "explainer" layer
   in code: word-by-word captions, animated charts, arrows, numbers and
   transitions, rendered as vertical video. **Free for individuals and
   companies up to 3 people.** This is the main thing that makes production
   automatable.

---

## 3. Minecraft → Blender toolkit (websites/add-ons)

| Tool | What it's for | Notes |
|---|---|---|
| **Blender 5.2 LTS** | Main animation app | Free. Needs 16 GB RAM and a decent GPU to be comfortable |
| **MCprep** (Moo-Ack Productions) | Fixes Minecraft materials, spawns mobs/players/items, animated textures | v3.6.x; supports Blender 5.x (5.0 fixes landed in 3.6.2) |
| **jmc2obj** / **Mineways** | Export a piece of your Minecraft world to Blender | jmc2obj has historically worked best with MCprep |
| **Flashback** mod | Record gameplay, then re-shoot it with cinematic camera paths | Minecraft 1.21+. Exports MP4/PNG/EXR with depth |
| **Flashback Export Extras** | Exports the camera path as GLB and EXR for Blender compositing | Lets you match Blender overlays to in-game camera moves |
| **Replay Mod** + **Igrium's Replay Exporter** | Export a whole replay (world + movement) into Blender | Alternative to Flashback |
| **Boxscape Studios rig pack** | Player/mob rigs, continuation of the classic Rymdnisse pack | Free |
| **DigitalDan Simple Player Rig** | Beginner-friendly player rig with face, IK/FK, armor, cape | Free |
| **Thomas Rig Legacy** | Advanced rig, installable as a Blender extension | Free |
| **Blockbench** | Build **our own mascot** in Minecraft style, export glTF to Blender | Our own character = our IP = merch later |
| **Rhubarb Lipsync NG** / **LipKit** | Auto mouth shapes from the voice file | Pairs with the ElevenLabs voice |
| **QuickMagic** / **Rokoko Vision** | Act on your phone → 3D motion (FBX) | Free tiers (Rokoko: 30s/month free) |
| **Cascadeur** | Clean up mocap / physics-based posing | Free tier |
| **SheepIt** | Free community render farm | Slow queue; backup only. EEVEE renders shorts fast locally |
| Mine-imator | Easy Minecraft animator | Last real update 2.0.2 (2023). **Blender is our main path** |

---

## 4. How one short gets made

```
1. Trend Scout (Claude + vidIQ)   → 5 topic ideas         → Krew picks 1
2. Script Writer + Fact Checker    → 30–60s script, hook first 1–3s → Krew approves
3. Storyboard (Claude)             → shot list: set, camera move, action, on-screen text
4. Krew records in Minecraft       → Flashback clips + exported world chunk
5. Blender (Claude via connector)  → builds/sets up scene, vertical camera, lighting,
                                     camera moves, render settings
6. Krew animates the acting        → rig poses/keyframes (or phone mocap)
7. ElevenLabs (Claude)             → voiceover → Rhubarb lip sync on the rig
8. Render (EEVEE, 1080×1920, 30fps)
9. Remotion (Claude Code)          → captions, charts, numbers, arrows over the render
10. Epidemic Sound (Claude)        → music + sound effects
11. Hook & Clarity Critic          → score it; fix weak spots
12. Canva                          → cover frame; Claude writes titles/hashtags per platform
13. Krew approves → post to YouTube Shorts, Instagram Reels, TikTok
14. Analyst                        → check the numbers below, feed the next topic
```

**Targets to judge each short** (YouTube Studio → "Viewed vs swiped away"):
- 70%+ viewed vs swiped away = great, ~50% = average, under 30% = the hook failed.
- Average percentage viewed **70%+**.
- Keep 80%+ of viewers through the first 3 seconds.

---

## 5. This week's setup checklist

**Day 1 — Install**
- [ ] Install **Blender 5.2 LTS** and **Claude Desktop** on your computer.
- [ ] Add the **Blender connector** (steps above) and test it: *"Make a 1080×1920 scene with a camera that slowly pushes in on a cube."*
- [ ] Install **MCprep**, and one rig pack (start with **DigitalDan Simple Player Rig**).

**Day 2 — Minecraft capture**
- [ ] Install Fabric + **Flashback** (and Export Extras) on Minecraft 1.21+.
- [ ] Install **jmc2obj** or **Mineways**. Build a small set (for example a
  village trading hall for the inflation episode) and export it to Blender
  with MCprep.

**Day 3 — Sound + voice connectors**
- [ ] Connect **ElevenLabs** (hosted MCP) and pick the host voice.
- [ ] Connect **Epidemic Sound** (if subscribing) and **vidIQ**.
- [ ] Install **Rhubarb Lipsync NG** in Blender.

**Day 4–5 — First short, end to end**
- [ ] Topic: "How inflation works, explained with villager trading."
- [ ] Follow section 4 by hand. It's fine if it's slow, because we're
  finding the bottlenecks.

**Day 6–7 — Automate the explainer layer**
- [ ] In a Claude Code session: set up the **Remotion** project +
  agent skills, and make templates: hook text, captions, chart, outro.
- [ ] Make short #2 and #3 using the templates.

---

## 6. Rules that protect the money

- **YouTube "inauthentic content" policy** covers Shorts too. It demonetizes
  videos that follow a template with little variation, are made at scale, and
  have no real author input. The penalties escalate: warning, then 90-day
  suspension, then removal from the Partner Program. → Every short needs
  Krew's creative input: acting, jokes, choices. Don't post straight AI output.
- **Minecraft Usage Guidelines** (updated August 2026) → put a disclaimer in
  the description: *"Not an official Minecraft product. Not approved by or
  associated with Mojang or Microsoft."* Don't use Minecraft to promote
  unrelated brands without permission. Merch must be our own mascot.
- **AI video tools** → only for real-world cutaways (money, factories, maps),
  never to recreate game characters. Sora was discontinued in 2026, so it's
  not in the plan.
- **Music** → only licensed sources (Epidemic Sound, ElevenLabs music, YouTube
  Audio Library).

---

## 7. Open questions for Krew

1. What computer do you have (RAM + graphics card)? This decides local
   rendering vs render farm.
2. Is Claude Desktop installed on it?
3. OK to pay for **Epidemic Sound** and **ElevenLabs**, or start with free
   options (YouTube Audio Library + ElevenLabs free tier)?
4. Mascot: design our own Minecraft-style host in Blockbench now, or start
   with a standard player skin?

---

## Sources

- [Claude for Creative Work — Anthropic](https://www.anthropic.com/news/claude-for-creative-work)
- [Anthropic releases 9 Claude connectors for creative tools — 9to5Mac](https://9to5mac.com/2026/04/28/anthropic-releases-9-new-claude-connectors-for-creative-tools-including-blender-and-adobe/)
- [Using the Blender Connector in Claude — Claude Academy](https://academy.claude.com/tutorials/using-the-blender-connector-in-claude)
- [Blender Lab MCP Server](https://www.blender.org/lab/mcp-server/) / [projects.blender.org/lab/blender_mcp](https://projects.blender.org/lab/blender_mcp)
- [Official Blender MCP comparison — StraySpark](https://www.strayspark.studio/blog/official-blender-mcp-server-comparison-2026)
- [Claude + Blender MCP: what it can and can't do — MindStudio](https://www.mindstudio.ai/blog/claude-blender-mcp-real-world-performance)
- [MCP for Blender (ahujasid) — GitHub](https://github.com/ahujasid/blender-mcp)
- [Blender 5.2 LTS release](https://www.blender.org/download/releases/5-2/)
- [MCprep releases — GitHub](https://github.com/Moo-Ack-Productions/MCprep/releases)
- [MCprep world exporters](https://theduckcow.com/dev/blender/mcprep/setup-world-exporters/)
- [Flashback mod — Modrinth](https://modrinth.com/mod/flashback) / [Flashback Export Extras — CurseForge](https://www.curseforge.com/minecraft/mc-mods/flashback-export-extras) / [Igrium's Replay Exporter](https://modrinth.com/mod/replay-export)
- [Boxscape Studios rig pack](https://www.nari3d.com/boxscape) / [DigitalDan Simple Player Rig](https://digitaldananimations.gumroad.com/l/smprold) / [Thomas Rig Legacy](https://extensions.blender.org/add-ons/thomas-rig-legacy/)
- [Blockbench → Blender workflow](https://blockbench.org/blender-workflow-for-minecraft-models/)
- [Rhubarb Lipsync NG — GitHub](https://github.com/Premik/blender_rhubarb_lipsync_ng)
- [AI mocap for Blender pipelines — Viggle](https://viggle.ai/blog/best-ai-motion-capture-tools-blender-unreal) / [QuickMagic comparison](https://www.quickmagic.ai/Learning/getting-started/Free-AI-Motion-Capture-Top-Tools-Compared)
- [ElevenLabs changelog 2026-08-22 (hosted MCP)](https://elevenlabs.io/docs/changelog/2026/8/22) / [ElevenLabs MCP — GitHub](https://github.com/elevenlabs/elevenlabs-mcp)
- [Epidemic Sound MCP connector in Claude's directory](https://corporate.epidemicsound.com/press-and-media/press-releases/2026/epidemic-sound-launches-mcp-connector-in-claudes-directory/)
- [Remotion agent skills](https://www.remotion.dev/docs/ai/skills) / [Remotion license FAQ](https://www.remotion.dev/docs/license/faq)
- [Adobe for creativity connector](https://blog.adobe.com/en/publish/2026/04/28/adobe-for-creativity-connector) / [What it does and doesn't do — MindStudio](https://www.mindstudio.ai/blog/claude-mcp-adobe-vs-photoshop-premiere-what-it-does)
- [Best AI video generators Sept 2026 — BuildMVPFast](https://www.buildmvpfast.com/articles/best-llms-2026-guide/video-generation-ai) / [Veo vs Kling vs Runway — Get AI Perks](https://www.getaiperks.com/en/blogs/44-best-ai-video-generators-2026)
- [SheepIt render farm](https://www.sheepit-renderfarm.com/home)
- [Mine-imator version history](https://mineimator.fandom.com/wiki/Mine-imator_version_history)
- [YouTube clarifies AI slop policies — TechCrunch](https://techcrunch.com/2026/07/20/youtube-clarifies-policies-around-ai-slop-and-upsetting-videos/) / [YouTube monetization policies](https://support.google.com/youtube/answer/1311392?hl=en)
- [Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines)
- [YouTube Shorts retention benchmarks 2026 — Shortimize](https://www.shortimize.com/blog/youtube-shorts-retention-rate)
