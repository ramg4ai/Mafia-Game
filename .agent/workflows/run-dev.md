---
description: How to start the Mafia game development server
---

## Start the Mafia Game Server

// turbo
1. Run the server with npm:
```bash
npm start
```
The server starts at **http://localhost:3000**.

Console output on success:
```
🎭 Mafia Game Server running at http://localhost:3000
   Share your local IP with teammates on the same network
   For VPN users: run 'npx ngrok http 3000' for a public URL
```

2. Open **http://localhost:3000** in a browser to play.

## Notes

- The server does **not** auto-restart on file changes. Stop it with `Ctrl+C` and re-run `npm start` after code changes.
- To expose the server to the internet for remote testing, run `npx ngrok http 3000` in a separate terminal.
- The `PORT` environment variable overrides the default port 3000: `PORT=4000 npm start`.
