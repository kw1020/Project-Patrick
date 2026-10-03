# Patrick Homework Helper

Patrick's first paid product. Students type a question or snap a photo of their homework (math, reading, science, anything), and Patrick walks them through it step by step.

## Run it

1. Get an Anthropic API key at https://console.anthropic.com (add about $10 of credit to start).
2. Install and start:
   ```bash
   npm install
   ANTHROPIC_API_KEY=sk-ant-... PATRICK_ACCESS_CODES=customer1-code npm start
   ```
3. Open http://localhost:3000

No API key yet? Leave out `ANTHROPIC_API_KEY` and Patrick runs in **demo mode**, sending a sample math answer so you can try the app.

`PATRICK_ACCESS_CODES` is a comma-separated list. Give each paying customer their own code, and remove a code if they stop paying.

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
