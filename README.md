# QuestMap LA

A demo of a real-world, location-based LARP game. Your GPS dot is your character. You walk to hard-to-reach spots around LA to open treasure chests, meet nearby players to battle or chat, and shop at real locations.

## What's in the demo

- **Map + character**: Your custom avatar is your location marker. Tap 📍 to use real GPS; otherwise you're in demo mode in Santa Monica and can drag your character around.
- **Treasure chests** at 7 LA spots: the Mt. Lee summit, Griffith Observatory, the top of Runyon Canyon, the end of Santa Monica Pier, Temescal Canyon falls, Parker Mesa Overlook and Echo Mountain. A chest only opens when you're within 60 m. Each one drops a wearable item and coins.
- **Character creator**: Pick skin, hair, hair color and outfit. You can wear gear from treasures and shops (hats, face and neck items), and it changes your ATK and DEF.
- **Nearby players**: Other players within 500 m can be sent a ⚔️ battle or 💬 talk request, and they can also send requests to you. In this demo they're simulated bots.
- **Game Boy–style battles**: ATTACK / DEFEND / ACT / RUN. ACT includes TRUCE (offer to end the battle early), PRAISE (lowers their attack), PAY (buy your way out) and ITEM. If you lose, you forfeit 25% of your coins.
- **Talk**: Chat, ask for tips, trade items and add friends.
- **Shops** at real places, such as a pharmacy on 3rd St Promenade and a surf shack by the pier. You have to be there in person to buy.

Progress is saved in the browser (localStorage).

## Run locally

It's plain HTML/CSS/JS with no build step:

```bash
npx http-server . -p 5173
```

GPS needs HTTPS or localhost.

## Deploy

It's a static site. Import the GitHub repo into Vercel with the default settings and no framework, or run `npx vercel --prod`.

## Next steps for a real version

- A backend for real multiplayer: accounts, live player positions with a websocket/realtime database, and battles and trades resolved on the server so nobody can cheat.
- GPS spoof protection, plus rules so chests can't be claimed from a car on the freeway.
- Privacy: fuzz player locations, friends-only visibility, block/report, and age gating.
- Safety review of treasure spots (trail conditions, closures, heat warnings).
- Partnerships so real stores can become sponsored shops.
