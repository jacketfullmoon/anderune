// Static game data for the demo. In a real app this would come from a server.

const START = { lat: 34.0155, lng: -118.4945, label: 'Santa Monica' }; // near 3rd St Promenade
const CLAIM_RADIUS_M = 60;   // how close you must be to open a chest
const NEARBY_RADIUS_M = 500; // how close another player must be to interact

// Every item in the game. slot = where it goes on your avatar (or 'use' for consumables).
const ITEMS = {
  // Treasure-only cosmetics
  crown:       { name: 'Hollywood Crown',     ico: '👑', slot: 'hat',  rarity: 'Legendary', atk: 3, desc: 'From the summit behind the Hollywood Sign.' },
  telescope:   { name: 'Star Goggles',        ico: '🥽', slot: 'face', rarity: 'Epic',      def: 2, desc: 'Found on the Griffith Observatory lawn.' },
  bandana:     { name: 'Trail Bandana',       ico: '🧣', slot: 'neck', rarity: 'Rare',      def: 1, desc: 'Tied to a post at the top of Runyon Canyon.' },
  pirate:      { name: 'Pier Pirate Hat',     ico: '🏴‍☠️', slot: 'hat',  rarity: 'Rare',      atk: 2, desc: 'Washed up at the end of Santa Monica Pier.' },
  flower:      { name: 'Waterfall Lei',       ico: '🌺', slot: 'neck', rarity: 'Rare',      def: 1, desc: 'Left beside the Temescal Canyon falls.' },
  wizard:      { name: 'Ridge Wizard Hat',    ico: '🧙', slot: 'hat',  rarity: 'Epic',      atk: 2, def: 1, desc: 'Guarded at Parker Mesa Overlook.' },
  lantern:     { name: 'Echo Lantern',        ico: '🏮', slot: 'neck', rarity: 'Epic',      atk: 1, def: 2, desc: 'From the ruins on Echo Mountain.' },
  // Shop cosmetics
  shades:      { name: 'Beach Shades',        ico: '🕶️', slot: 'face', rarity: 'Common',    atk: 1, price: 80,  desc: 'Look cool, hit slightly harder.' },
  cap:         { name: 'Dodger-Blue Cap',     ico: '🧢', slot: 'hat',  rarity: 'Common',    def: 1, price: 60,  desc: 'Classic LA headwear.' },
  scarf:       { name: 'Marine Layer Scarf',  ico: '🧶', slot: 'neck', rarity: 'Common',    def: 1, price: 50,  desc: 'For June gloom.' },
  // Consumables
  potion:      { name: 'Electrolyte Drink',   ico: '🧃', slot: 'use',  rarity: 'Common',    heal: 15, price: 25, desc: 'Restores 15 HP.' },
  bigpotion:   { name: 'Açaí Bowl',           ico: '🥣', slot: 'use',  rarity: 'Uncommon',  heal: 40, price: 55, desc: 'Fully restores HP.' },
  sunscreen:   { name: 'SPF 50',              ico: '🧴', slot: 'use',  rarity: 'Common',    heal: 8,  price: 15, desc: 'Restores 8 HP. Protects your skin IRL too.' },
  map:         { name: 'Local Tip Map',       ico: '🗺️', slot: 'use',  rarity: 'Uncommon',  price: 40, desc: 'Reveals a hint about a hidden treasure.' },
};

// Hidden treasure chests at hard-to-reach LA spots.
const TREASURES = [
  { id: 't_lee',     item: 'crown',     name: 'Mt. Lee Summit',            lat: 34.13426, lng: -118.32138, coins: 150, hint: 'Hike behind the Hollywood Sign via Brush Canyon — ~6 mi round trip.' },
  { id: 't_griff',   item: 'telescope', name: 'Griffith Observatory',      lat: 34.11842, lng: -118.30039, coins: 80,  hint: 'Take the Charlie Turner Trail up from the Greek Theatre.' },
  { id: 't_runyon',  item: 'bandana',   name: 'Runyon Canyon Top',         lat: 34.11206, lng: -118.35053, coins: 60,  hint: 'Take the steep east ridge to the bench at the top.' },
  { id: 't_pier',    item: 'pirate',    name: 'End of Santa Monica Pier',  lat: 34.00827, lng: -118.49985, coins: 40,  hint: 'Walk all the way to the end, past the fishermen.' },
  { id: 't_temescal',item: 'flower',    name: 'Temescal Canyon Falls',     lat: 34.06305, lng: -118.53232, coins: 70,  hint: 'Loop trail from Sunset Blvd, ~3 mi with a small waterfall.' },
  { id: 't_parker',  item: 'wizard',    name: 'Parker Mesa Overlook',      lat: 34.05484, lng: -118.55942, coins: 110, hint: 'Long fire road climb from Paseo Miramar with views of the whole bay.' },
  { id: 't_echo',    item: 'lantern',   name: 'Echo Mountain Ruins',       lat: 34.21259, lng: -118.12658, coins: 120, hint: 'Sam Merrill Trail in Altadena — steep switchbacks to old railway ruins.' },
];

// Real-world places that act as in-game shops.
const SHOPS = [
  { id: 's_pharm',  name: 'Promenade Pharmacy',  ico: '💊', lat: 34.01648, lng: -118.49628, stock: ['potion', 'bigpotion', 'sunscreen'],
    blurb: 'A drugstore on 3rd St Promenade. In the real product, partner stores (think a Rite Aid or CVS) could be sponsored shops.' },
  { id: 's_surf',   name: 'Pier Surf Shack',     ico: '🏄', lat: 34.00960, lng: -118.49700, stock: ['shades', 'cap', 'sunscreen'],
    blurb: 'Beach gear by the Santa Monica Pier.' },
  { id: 's_trail',  name: 'Trailhead Outfitters',ico: '⛺', lat: 34.10390, lng: -118.34900, stock: ['scarf', 'potion', 'map'],
    blurb: 'Stock up before hitting Runyon Canyon.' },
  { id: 's_market', name: 'Main St Market',      ico: '🛒', lat: 34.00200, lng: -118.48660, stock: ['bigpotion', 'map', 'cap'],
    blurb: 'Snacks and supplies on Main Street.' },
];

// Simulated other players. Positions are offsets (meters) from wherever you are.
const NPCS = [
  { id: 'p_maya',  name: 'MayaRuns',   lvl: 7, hp: 34, atk: 7, def: 3, coins: 140,
    look: { skin: '#8d5524', hair: 'long', hairColor: '#1b1b1b', shirt: '#ff5a4e', hat: 'cap',    face: null,        neck: null },
    greet: 'hey! you doing the pier chest too?', tip: 'The Mt. Lee chest is worth the hike, go early before it gets hot.', offer: 'scarf', wants: 'potion' },
  { id: 'p_dev',   name: 'DevOnWheels',lvl: 5, hp: 28, atk: 6, def: 2, coins: 90,
    look: { skin: '#f1c27d', hair: 'spiky', hairColor: '#e6b422', shirt: '#2fbf71', hat: null,     face: 'shades',    neck: null },
    greet: 'yo 🛹 wanna trade?', tip: 'Surf Shack sells shades for 80 coins, +1 attack.', offer: 'sunscreen', wants: 'shades' },
  { id: 'p_luz',   name: 'LuzQuest',   lvl: 9, hp: 40, atk: 8, def: 4, coins: 220,
    look: { skin: '#c68642', hair: 'bun',  hairColor: '#4a2a12', shirt: '#8b5cf6', hat: 'wizard', face: null,        neck: 'lantern' },
    greet: 'greetings, traveler ✨', tip: 'Echo Mountain is brutal but the lantern gives +2 def.', offer: 'bigpotion', wants: 'crown' },
  { id: 'p_sam',   name: 'SamTheHiker',lvl: 4, hp: 26, atk: 5, def: 2, coins: 60,
    look: { skin: '#ffdbac', hair: 'short',hairColor: '#8b4513', shirt: '#f59e0b', hat: null,     face: null,        neck: 'bandana' },
    greet: 'just got back from Runyon lol my legs', tip: 'Take the east ridge at Runyon, the chest is by the top bench.', offer: 'potion', wants: 'sunscreen' },
  { id: 'p_kai',   name: 'Kai_Waves',  lvl: 6, hp: 30, atk: 7, def: 2, coins: 110,
    look: { skin: '#e0ac69', hair: 'curly',hairColor: '#2b1a0e', shirt: '#06b6d4', hat: 'pirate', face: null,        neck: null },
    greet: 'surf was flat today 🌊', tip: 'Trailhead Outfitters sells a Tip Map that points to hidden chests.', offer: 'cap', wants: 'map' },
];

const AVATAR_OPTIONS = {
  skin: ['#ffdbac', '#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#5c3a1e'],
  hair: ['short', 'long', 'spiky', 'curly', 'bun', 'bald'],
  hairColor: ['#1b1b1b', '#4a2a12', '#8b4513', '#e6b422', '#d9534f', '#6d28d9', '#e5e7eb'],
  shirt: ['#3b82f6', '#ff5a4e', '#2fbf71', '#f59e0b', '#8b5cf6', '#06b6d4', '#1d1d27', '#ec4899'],
};
