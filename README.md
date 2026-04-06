# Russian Companion — Deployment Guide

## What this is
A voice-only AI companion for a Russian speaker. Always listening, pulls news,
remembers past conversations across sessions.

## Files
- `server.js` — Node.js backend (handles API calls, stores history)
- `public/index.html` — the frontend (avatar, voice, UI)
- `history.json` — created automatically, stores conversation history

---

## Deploy to Railway (10 minutes)

1. **Create a free account** at https://railway.app

2. **Install Railway CLI** (optional but easier):
   ```
   npm install -g @railway/cli
   railway login
   ```

3. **Create a new project**:
   - Go to railway.app → New Project → Deploy from GitHub
   - Or drag this folder into the Railway dashboard

4. **Set your API key** as an environment variable:
   - In Railway dashboard → your project → Variables
   - Add: `ANTHROPIC_API_KEY` = your key from console.anthropic.com

5. **Deploy** — Railway builds and starts automatically.

6. **Get your URL** — Railway gives you a URL like `https://your-app.railway.app`
   - Open that URL in Chrome on her device
   - Bookmark it or save to home screen

---

## Run locally (for testing)

```bash
npm install
ANTHROPIC_API_KEY=your_key_here npm start
```

Then open http://localhost:3000 in Chrome.

---

## Conversation memory
- History is saved in `history.json` on the server
- Keeps the last 100 turns
- Persists between sessions automatically
- To reset: POST to /clear or delete history.json

---

## Cost estimate (all-day use)
- Haiku for conversation: ~$0.50–2/day
- Sonnet for morning news greeting: ~$0.01/day  
- Railway hosting: free tier or $5/month
- Total: ~$15–60/month depending on usage
