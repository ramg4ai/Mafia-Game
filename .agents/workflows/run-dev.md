---
description: How to start the Mafia game server
---

## Steps

1. Open a terminal and navigate to the project directory:
```
cd "/Users/ramkumar.g/Projects/Mafia Game"
```

// turbo
2. Install dependencies (first time only):
```
npm install
```

// turbo
3. Start the server:
```
node server.js
```

4. Open your browser and go to `http://localhost:3000`.

5. Share with teammates:
   - **Same network**: Share your local IP (e.g., `http://192.168.x.x:3000`)
   - **VPN / remote**: Run `npx ngrok http 3000` in a separate terminal and share the ngrok URL
