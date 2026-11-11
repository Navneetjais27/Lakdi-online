# Lakdi Online 🃏

A real-time, 4-player Lakdi card game. Each player uses their own phone browser. No app install, and no npm packages needed.

## Features
- Create a room and share the 4-letter code or invite link (WhatsApp etc.)
- Trump finding: 4 cards are opened at a time until a Joker (Jack) appears
- 13 cards each, 13 rounds per match
- **Say your hand**: before play, every player says how many rounds they will win (1–13)
- Must follow suit; if you can't, cut with trump
- Scoring: win at least what you said → 10 points for every round won (said 2, won 4 → 40); win fewer → minus 10 × what you said (said 2, won 1 → −20). Totals carry across matches
- Fill empty seats with computer players
- If a phone disconnects, it rejoins automatically. The host can also let the computer play for an offline player

## Play at home on the same Wi-Fi (quickest test)
1. Install Node.js 18 or newer from https://nodejs.org on a laptop.
2. In this folder, run: `node server.js`
3. Find the laptop's local IP address (Windows: `ipconfig`, Mac: `ipconfig getifaddr en0`), for example 192.168.1.5.
4. Every phone on the same Wi-Fi opens `http://192.168.1.5:3000`.

## Put it on the internet (free) – Render.com
1. Create a GitHub account and upload this folder as a new repository.
2. On https://render.com choose **New → Web Service** and connect the repository.
3. Settings: Runtime **Node**, Build command: *(leave empty)*, Start command: `node server.js`, Instance: **Free**.
4. Deploy. You get a link like `https://lakdi-online.onrender.com` that friends can open anywhere.

Railway, Fly.io, Glitch, or any VPS also work. They only need to run `node server.js`, and the `PORT` environment variable is respected.

Note: free Render servers sleep after about 15 minutes of no use. The first visit after that takes about 30 seconds to wake. Rooms are kept in memory, so a server restart ends the games in progress.

## Files
- `server.js`: game server (rooms, rules, computer players, real-time updates using Server-Sent Events)
- `index.html`: the game screen that each phone sees
