# Quest

A real-world, location-based LARP game. Your GPS dot is your character. Walk to hard-to-reach spots around LA to open treasure chests, meet other players in person to battle, chat or trade, and shop at real locations.

Plain HTML/CSS/JS — no build step. Map: MapLibre GL with OpenFreeMap's vector basemap (OpenStreetMap data, no API key), the same map the gas app uses, repainted at runtime by `applyMapTheme()` — the "Anderune" style warms the ground, saturates parks and water, and hides sidewalk/footpath clutter so game markers stay the loudest thing on screen. It has day and night palettes, and ⚙️ → Map style switches back to Classic (the untouched basemap) at any time. `map-preview.html` is a standalone page for comparing styles side by side; it isn't part of the app. Multiplayer runs on Firebase (Auth + Firestore).

## Accounts

Sign up with a **character name + password + optional password hint**. No email, same as the gas app: the name becomes a hidden fake address (`name@questmap.local`). On the Log In tab, "Forgot password? Show my hint" looks the hint up by name.

## What's in it

- **Special attacks** — name your own ("Zack Attack") and pick its emoji in the character creator; the battle announces it by name.
- **Character creator** — skin, hair, hair color, outfit, plus gear you find or buy. Your character is your map marker and battle portrait. Tops include t-shirt, tank, long sleeve, hoodie, zip-up and jacket, and you pick the circle colour behind your character (light or dark). You can also upload a photo instead: you frame it yourself by dragging and zooming in a circular cropper, and it's saved at 160px (a couple of KB). Everyone playing can see it.
- **Footprint trails** — 👣 emoji follow behind each player along the way they walked, fading out with age. Your icon stays at your current spot.
- **Night map** — the map darkens from 7pm to 6am on the player's own clock.
- **Local testing** — on localhost the app uses a fake in-browser backend so test accounts never touch the real database. Add `?live` to the URL to hit Firebase from localhost.
- **Treasure chests** at 7 real LA spots (Mt. Lee summit, Griffith Observatory, top of Runyon Canyon, end of Santa Monica Pier, Temescal Canyon falls, Parker Mesa Overlook, Echo Mountain). A chest opens only within 60 m. Each gives coins and a wearable item that changes your ATK/DEF.
- **Live players** — everyone signed in shows on the map with their avatar while their location is fresh (10 min). Friends get a green ring.
- **Requests** — ⚔️ battle or 💬 talk (within 500 m), 🤝 friend (any distance). The other person accepts or declines.
- **Battles** — real turn-based PvP between two phones: **Attack / Defend / Act / Run**. Attack opens a weapon choice (👊 punch — weaker but crits often, 🗡️ dagger — high crit, ⚔️ sword — hardest hit) plus your own **special attack**, once per battle. Hits fly in as animated emoji and the target flashes red; defending blooms a shield out of the middle of the screen; specials orbit the enemy trailing sparks before bursting. Act also has **Chat**, so you can talk mid-fight — negotiate, or just say "you're good, can I add you?". Act covers Truce (end it early, both must agree), Praise (lowers their attack), Pay 30 coins, and Use item. Lose and you forfeit 25% of your coins to the winner.
- **Parties** — ask a nearby player to join your party ("Zack asked if you want to join their party"). You stay partied until midnight, and you fight together: a challenge becomes 2-on-1. If the solo player wins they collect 25% from *both* losers (double); if the party wins they split the single loser's 25% evenly.
- **Quests** — walk a story line between real places, pick up key items, and finish with an AI boss fight. Three are built in; players can write their own with the quest builder (tap the map to place each stop, invent a monster, name the medal) and invite friends.
- **The world is Southern California** — `REGION` in `data.js` bounds the map to Malibu and the Valley down through LA to Mission Viejo. The camera can't leave it, monsters don't spawn outside it, and a player whose GPS is outside gets told so rather than staring at an empty map.
- **Ocean monsters** — anything that spawns over water becomes a 🦈 / 🐙 / 🐍 sea creature at least 20 levels above you, marked with a red glow and a ☠️. The card warns you outright. Water is detected by point-in-polygon against the map's real water geometry, so it works for spawns that are off screen, and it's re-checked as they wander — cross the shoreline and a monster changes either way.
- **Wild monsters** — 🐻 grizzlies, 🤖 rusted bots and 🐺 coyotes roam near you and are always fightable, so you can level up with nobody else online. Walk within 80 m, tap, fight. Win: coins + XP scaled to their level. Lose: only 10% of your coins (PvP costs 25%). A beaten one leaves and the area stays quiet for 25–70 seconds.
- **AR battles** — tap 📷 AR in any fight to put the rear camera behind it. The enemy is pinned to its real spot using the phone's compass: turn away and it slides off screen (with an arrow pointing back), turn back and it's still standing where it was. The action buttons float with it, so they're always in front of whatever the enemy is standing by. The feed is drawn ~190px wide and posterised to 10 steps per channel for a chunky-but-readable look, with threshold bloom on the highlights. Your own sprite hides (you're holding the phone). Needs https, camera permission, and motion access for the compass; without motion access the enemy just stays centred. Toggling off or leaving the battle releases the camera.
- **Levels and stat points** — XP scales with who you beat: an even fight is worth about 45, someone five levels above you about 120, a level 2 monster about 7. Each level needs more than the last, grants **2 stat points to spend yourself** (attack, defense, special power, negotiate), and throws in a point or two automatically. Negotiate raises the odds a monster accepts your truce; special power raises your special attack's damage.
- **Rest stops** — every real bus stop nearby (pulled live from OpenStreetMap, cached for a day) is a 🚏✚ rest point. Stand at one and rest to go back to full HP, with a few minutes' cooldown before that stop works again.
- **Day/night arc** — a small Majora's Mask style arc at the top of the map: the ☀️ climbs it through the day, the 🌙 takes over at night. Tap it to see how long until it flips.
- **Accomplishments** — battles fought, battles won, treasures found, quests finished, medals earned, plus leaderboards.
- **Search** — find any player by character name.
- **Talk** — live chat, item trades (both sides confirm), add friend.
- **Shops** at real places; you must be there in person to buy.

## Sound

All effects are synthesised with the Web Audio API at runtime — no audio files ship with the app. `SFX.play(name)` covers taps, sheet opens, swings, impacts, shields, heals, specials, coins, level ups, wins and losses. The ⚙️ gear on the map opens settings: sound effects on/off with its own volume, plus a music row that stores its setting for whenever a soundtrack exists. Settings live in `localStorage`, per device. iOS only allows audio after a tap, so the first touch anywhere unlocks it.

## Admin test battles

An account listed in `ADMIN_NAMES` gets "🧪 Test battles" in its profile: practice fights against a test player or a test monster. Nothing counts — no coins, no XP, no record.

## Home-screen icon

`icons/icon-180.png` is the Apple touch icon (📜 scroll with a 🎮 controller on top, on the app's purple gradient); 192 and 512 versions are listed in `manifest.json` for Android. On iPhone: open the site in Safari → Share → **Add to Home Screen**. It installs as "Anderune" and opens full screen with no browser chrome. To redraw the icons, re-run the Pillow script in the commit history (it renders the real Apple emoji from the system font).

## Admins

`ADMIN_NAMES` in `data.js` lists the character names that count as "Anderune masters" (case-insensitive). They get a badge and can delete any player-written quest.

## Firebase setup (one time)

1. Go to https://console.firebase.google.com/ and create a project (free Spark plan).
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable.**
3. **Build → Firestore Database → Create database** (production mode, any region).
4. In Firestore → **Rules**, paste this and Publish:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Name → hint lookup must work before login
    match /qm_usernames/{name} {
      allow read: if true;
      allow create: if request.auth != null;
    }
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

5. **Project settings → Your apps → Web app (`</>`)** → register an app → copy the `firebaseConfig` values into `FIREBASE_CONFIG` at the top of `backend.js`.
6. Redeploy.

Note: any signed-in player can write any player's data (that's how coins move at the end of a battle). Fine for playing with friends; a public launch would need server-side rules or Cloud Functions.

## Run locally

```bash
npx http-server . -p 5173
```

Without a Firebase config, localhost falls back to a fake in-browser backend so you can test with two tabs (each tab is a separate player). GPS needs https or localhost.

## Deploy

Static site. Import the repo into Vercel with no framework and default settings, or run `npx vercel --prod`.

## Privacy and safety notes for a real launch

- Player locations are visible to everyone signed in while the app is open. A real version needs friends-only visibility, fuzzed positions, block/report, and age gating.
- GPS spoof protection, and rules so chests can't be claimed from a moving car.
- Check treasure spots for trail conditions, closures and heat warnings.
- Partnerships if real store brands are used as shops.
