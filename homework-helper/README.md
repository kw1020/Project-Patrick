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

`PATRICK_ACCESS_CODES` is a comma-separated list. Give each paying customer their own code, and remove a code if they stop paying.

## Put it online (so the customer can use it on their phone)

Deploy this folder to Render, Railway, or Fly.io as a Node web service:
- Start command: `npm start`
- Environment variables: `ANTHROPIC_API_KEY` and `PATRICK_ACCESS_CODES`

## Costs

Each question costs a few cents in API fees, so one student pays roughly $2–8 a month. At $50 a month per student, most of that is profit.
