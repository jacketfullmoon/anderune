/* QuestMap LA — location-based LARP demo.
   Single-player simulation: other "players" are bots that wander near you. */

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function distM(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function offsetM(p, dx, dy) {
  return { lat: p.lat + dy / 111320, lng: p.lng + dx / (111320 * Math.cos(p.lat * Math.PI / 180)) };
}
function fmtDist(m) { return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`; }

// ---------- state ----------
const DEFAULT_STATE = {
  name: '', look: { skin: '#f1c27d', hair: 'short', hairColor: '#4a2a12', shirt: '#3b82f6' },
  equipped: { hat: null, face: null, neck: null },
  bag: { potion: 2 }, coins: 120, hp: 34, lvl: 5, xp: 0,
  claimed: [], friends: [], pos: { lat: START.lat, lng: START.lng },
};
let S;
try { S = { ...structuredClone(DEFAULT_STATE), ...JSON.parse(localStorage.getItem('questmap') || '{}') }; }
catch { S = structuredClone(DEFAULT_STATE); }
function save() { try { localStorage.setItem('questmap', JSON.stringify(S)); } catch {} }

const maxHp = () => 24 + S.lvl * 2;
function gearStat(k) { return Object.values(S.equipped).reduce((t, id) => t + ((id && ITEMS[id][k]) || 0), 0); }
const myAtk = () => 5 + Math.floor(S.lvl / 2) + gearStat('atk');
const myDef = () => 1 + Math.floor(S.lvl / 3) + gearStat('def');
function addItem(id, n = 1) { S.bag[id] = (S.bag[id] || 0) + n; }
function removeItem(id, n = 1) {
  S.bag[id] = (S.bag[id] || 0) - n;
  if (S.bag[id] <= 0) { delete S.bag[id]; for (const k in S.equipped) if (S.equipped[k] === id) S.equipped[k] = null; }
}

// ---------- avatar ----------
function avatarSVG(look, eq = {}) {
  const hat = eq.hat, face = eq.face, neck = eq.neck;
  const hc = look.hairColor;
  const hair = {
    short: `<path d="M18 27 Q17 12 32 12 Q47 12 46 27 Q40 18 32 19 Q24 18 18 27Z" fill="${hc}"/>`,
    long: `<path d="M17 28 Q16 10 32 10 Q48 10 47 28 L48 46 L42 46 L42 24 Q32 17 22 24 L22 46 L16 46Z" fill="${hc}"/>`,
    spiky: `<path d="M18 27 L15 13 L23 17 L25 7 L30 14 L34 5 L37 14 L42 8 L43 17 L50 13 L46 27 Q32 17 18 27Z" fill="${hc}"/>`,
    curly: [[19, 21], [25, 15], [32, 13], [39, 15], [45, 21]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6.5" fill="${hc}"/>`).join(''),
    bun: `<circle cx="32" cy="8" r="6" fill="${hc}"/><path d="M18 27 Q17 12 32 12 Q47 12 46 27 Q40 18 32 19 Q24 18 18 27Z" fill="${hc}"/>`,
    bald: '',
  }[look.hair] || '';
  const hats = {
    cap: `<path d="M17 23 Q17 9 32 9 Q47 9 47 23Z" fill="#1e40af"/><path d="M40 21 L56 23 Q50 26 44 25Z" fill="#1e3a8a"/><text x="30" y="21" font-size="8" font-family="Arial" font-weight="900" fill="#fff" text-anchor="middle">LA</text>`,
    crown: `<polygon points="19,21 18,7 25,14 32,5 39,14 46,7 45,21" fill="#f5b82e" stroke="#9a6a00" stroke-width="1.5"/><circle cx="32" cy="15" r="2.2" fill="#ef4444"/><circle cx="24" cy="17" r="1.6" fill="#3b82f6"/><circle cx="40" cy="17" r="1.6" fill="#3b82f6"/>`,
    pirate: `<path d="M9 22 Q32 -2 55 22 Q32 15 9 22Z" fill="#111"/><circle cx="32" cy="12" r="3" fill="#fff"/><path d="M29 16 L35 16" stroke="#fff" stroke-width="1.5"/>`,
    wizard: `<polygon points="19,21 45,21 36,-4" fill="#6d28d9"/><ellipse cx="32" cy="21" rx="17" ry="3.5" fill="#5b21b6"/><text x="34" y="14" font-size="8" text-anchor="middle" fill="#fde047">★</text>`,
  };
  const faces = {
    shades: `<rect x="20" y="25" width="10" height="6" rx="2" fill="#111"/><rect x="34" y="25" width="10" height="6" rx="2" fill="#111"/><path d="M30 27 L34 27" stroke="#111" stroke-width="1.5"/>`,
    telescope: `<path d="M17 28 L47 28" stroke="#78350f" stroke-width="2.5"/><circle cx="26" cy="28" r="5" fill="#7dd3fc" stroke="#92400e" stroke-width="2"/><circle cx="38" cy="28" r="5" fill="#7dd3fc" stroke="#92400e" stroke-width="2"/>`,
  };
  const necks = {
    bandana: `<path d="M21 42 L43 42 L32 53Z" fill="#dc2626"/><circle cx="29" cy="45" r="1" fill="#fff"/><circle cx="35" cy="45" r="1" fill="#fff"/>`,
    scarf: `<rect x="20" y="40" width="24" height="6" rx="3" fill="#a78bfa"/><rect x="36" y="44" width="5" height="11" rx="2" fill="#8b5cf6"/>`,
    flower: [20, 25, 30, 35, 40, 45].map((x, i) => `<circle cx="${x - 1}" cy="${43 + (i % 2) * 2}" r="3" fill="${['#f472b6', '#fbbf24', '#fb7185'][i % 3]}"/>`).join(''),
    lantern: `<path d="M32 42 L32 47" stroke="#444" stroke-width="1.5"/><rect x="27" y="47" width="10" height="11" rx="2" fill="#f59e0b" stroke="#7c2d12" stroke-width="1.5"/><circle cx="32" cy="52.5" r="2.5" fill="#fef08a"/>`,
  };
  const hideHair = hat === 'cap' || hat === 'pirate' || hat === 'wizard';
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <path d="M11 64 Q11 43 32 43 Q53 43 53 64Z" fill="${look.shirt}"/>
    <rect x="28" y="37" width="8" height="8" fill="${look.skin}"/>
    ${look.hair === 'long' && !hideHair ? hair : ''}
    <circle cx="32" cy="28" r="14" fill="${look.skin}"/>
    ${look.hair !== 'long' && !hideHair ? hair : ''}
    ${look.hair === 'long' && hideHair ? `<rect x="17" y="26" width="5" height="18" fill="${hc}"/><rect x="42" y="26" width="5" height="18" fill="${hc}"/>` : ''}
    <circle cx="27" cy="29" r="2" fill="#1d1d27"/><circle cx="37" cy="29" r="2" fill="#1d1d27"/>
    <circle cx="23" cy="33" r="2" fill="#f87171" opacity=".35"/><circle cx="41" cy="33" r="2" fill="#f87171" opacity=".35"/>
    <path d="M28.5 34.5 Q32 37.5 35.5 34.5" stroke="#1d1d27" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    ${(face && faces[face]) || ''}${(neck && necks[neck]) || ''}${(hat && hats[hat]) || ''}
  </svg>`;
}
const myAvatar = () => avatarSVG(S.look, S.equipped);
const npcAvatar = (n) => avatarSVG(n.look, n.look);

const CHEST_SVG = `<svg viewBox="0 0 32 32" width="34" height="34"><rect x="4" y="13" width="24" height="14" rx="2" fill="#a0522d" stroke="#3b1d0e" stroke-width="2"/><path d="M4 14 Q4 5 16 5 Q28 5 28 14Z" fill="#c2692f" stroke="#3b1d0e" stroke-width="2"/><rect x="4" y="13" width="24" height="3" fill="#f5b82e" stroke="#3b1d0e" stroke-width="1"/><rect x="13.5" y="12" width="5" height="8" rx="1" fill="#f5b82e" stroke="#3b1d0e" stroke-width="1.5"/></svg>`;

// ---------- map ----------
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([S.pos.lat, S.pos.lng], 16);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

let realGps = false;
const meIcon = () => L.divIcon({ className: '', iconSize: [44, 44], iconAnchor: [22, 22],
  html: `<div class="mk mk-me"><div class="mk-avatar">${myAvatar()}</div><div class="mk-label">${esc(S.name || 'You')}</div></div>` });
const meMarker = L.marker([S.pos.lat, S.pos.lng], { icon: meIcon(), draggable: true, zIndexOffset: 1000 }).addTo(map);
meMarker.on('dragend', () => { const p = meMarker.getLatLng(); setPos({ lat: p.lat, lng: p.lng }, false); });
meMarker.on('click', () => openTab('profile'));

function setPos(p, pan = true) {
  S.pos = { lat: p.lat, lng: p.lng }; save();
  meMarker.setLatLng([p.lat, p.lng]);
  if (pan) map.panTo([p.lat, p.lng]);
  keepNpcsNearby();
  checkProximity();
}

// treasures
const treasureMarkers = {};
function treasureIcon(t) {
  const claimed = S.claimed.includes(t.id);
  return L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17],
    html: `<div class="mk-poi chest ${claimed ? 'claimed' : ''}">${CHEST_SVG}</div>` });
}
TREASURES.forEach((t) => {
  treasureMarkers[t.id] = L.marker([t.lat, t.lng], { icon: treasureIcon(t) }).addTo(map).on('click', () => openTreasure(t));
});

// shops
SHOPS.forEach((s) => {
  L.marker([s.lat, s.lng], { icon: L.divIcon({ className: '', iconSize: [36, 36], iconAnchor: [18, 18],
    html: `<div class="mk-poi">${s.ico}</div>` }) }).addTo(map).on('click', () => openShop(s));
});

// bot players
const npcs = NPCS.map((n) => ({ ...n, pos: null, marker: null, curHp: n.hp }));
function placeNpc(n) {
  const ang = rand(0, Math.PI * 2), r = rand(90, 380);
  n.pos = offsetM(S.pos, Math.cos(ang) * r, Math.sin(ang) * r);
  if (!n.marker) {
    n.marker = L.marker([n.pos.lat, n.pos.lng], { icon: L.divIcon({ className: '', iconSize: [44, 44], iconAnchor: [22, 22],
      html: `<div class="mk mk-player"><div class="mk-avatar">${npcAvatar(n)}</div><div class="mk-label">${esc(n.name)}</div></div>` }) })
      .addTo(map).on('click', () => openPlayer(n));
  } else n.marker.setLatLng([n.pos.lat, n.pos.lng]);
}
function keepNpcsNearby() { npcs.forEach((n) => { if (!n.pos || distM(n.pos, S.pos) > 1500) placeNpc(n); }); }
keepNpcsNearby();
setInterval(() => { // wander
  npcs.forEach((n) => {
    n.pos = offsetM(n.pos, rand(-18, 18), rand(-18, 18));
    const d = distM(n.pos, S.pos);
    if (d > 600) n.pos = offsetM(n.pos, (S.pos.lng - n.pos.lng) * 2000, (S.pos.lat - n.pos.lat) * 2000); // drift back
    n.marker.setLatLng([n.pos.lat, n.pos.lng]);
  });
}, 2500);

// HP regen while exploring
setInterval(() => { if (!inBattle && S.hp < maxHp()) { S.hp++; save(); renderHud(); } }, 15000);

// ---------- GPS ----------
const locStatus = $('#loc-status');
function setStatus() {
  locStatus.textContent = realGps ? '📡 Live GPS — walk to explore' : '🕹️ Demo mode — drag your character to walk';
}
$('#locate-btn').onclick = () => {
  if (realGps) { map.setView([S.pos.lat, S.pos.lng], 16); return; }
  if (!navigator.geolocation) return toast('This device has no location support.');
  locStatus.textContent = 'Finding you…';
  navigator.geolocation.watchPosition((p) => {
    const first = !realGps;
    realGps = true; meMarker.dragging.disable(); setStatus();
    setPos({ lat: p.coords.latitude, lng: p.coords.longitude }, first);
    if (first) toast(`📡 Location on (±${Math.round(p.coords.accuracy)} m). Your blue dot is now your character.`);
  }, (e) => { setStatus(); toast(`Couldn't get location: ${e.message}. Staying in demo mode.`); },
  { enableHighAccuracy: true, maximumAge: 5000 });
};
setStatus();

// ---------- HUD ----------
function renderHud() {
  $('#hud-avatar').innerHTML = myAvatar();
  $('#hud-name').textContent = `${S.name || 'Traveler'} · Lv${S.lvl}`;
  $('#hud-coins').textContent = S.coins;
  const pct = Math.max(0, S.hp / maxHp() * 100);
  $('#hud-hp').style.width = pct + '%';
  $('#hud-hp').style.background = pct < 25 ? '#ef4444' : pct < 50 ? '#f5b82e' : '';
  meMarker.setIcon(meIcon());
}
$('#hud-avatar').onclick = () => openTab('profile');

// ---------- toasts ----------
function toast(html, buttons, ttl = 4500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  if (buttons) {
    const b = document.createElement('div'); b.className = 'btns';
    buttons.forEach(([label, cls, fn]) => {
      const btn = document.createElement('button'); btn.className = 'btn ' + cls; btn.textContent = label;
      btn.onclick = () => { el.remove(); fn && fn(); }; b.appendChild(btn);
    });
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  if (ttl) setTimeout(() => el.remove(), buttons ? ttl * 2 : ttl);
  return el;
}

// ---------- sheet ----------
const sheet = $('#sheet'), sheetBody = $('#sheet-body'), backdrop = $('#sheet-backdrop');
let sheetKind = null;
function openSheet(html, kind) {
  sheetKind = kind; sheetBody.innerHTML = html;
  sheet.classList.remove('hidden'); backdrop.classList.remove('hidden');
  sheet.scrollTop = 0;
}
function closeSheet() {
  sheet.classList.add('hidden'); backdrop.classList.add('hidden'); sheetKind = null;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'map'));
}
backdrop.onclick = closeSheet;

document.querySelectorAll('#nav button').forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));
function openTab(tab) {
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'map') return closeSheet();
  ({ bag: openBag, profile: openProfile, friends: openFriends })[tab]();
}

// ---------- treasure ----------
function openTreasure(t) {
  const d = distM(S.pos, t), inRange = d <= CLAIM_RADIUS_M, claimed = S.claimed.includes(t.id);
  const it = ITEMS[t.item];
  openSheet(`
    <div class="row"><div style="font-size:40px">${claimed ? '📭' : '🧰'}</div>
      <div><h2>${esc(t.name)}</h2>
      <span class="pill ${inRange ? 'ok' : 'far'}">${inRange ? 'You are here!' : fmtDist(d) + ' away'}</span>
      <span class="pill">${claimed ? 'Opened' : it.rarity + ' chest'}</span></div></div>
    <p>${claimed ? `You already found the <b>${it.ico} ${esc(it.name)}</b> here.` : esc(t.hint)}</p>
    ${claimed ? '' : `<p class="sub">Reward: ${it.rarity} item + ${t.coins} coins. Get within ${CLAIM_RADIUS_M} m to open it.</p>`}
    <div class="btns">
      ${claimed ? '' : `<button class="btn primary" id="claim" ${inRange ? '' : 'disabled'}>Open chest</button>`}
      <a class="btn" style="text-align:center;text-decoration:none;color:inherit" target="_blank" rel="noopener"
         href="https://www.google.com/maps/dir/?api=1&destination=${t.lat},${t.lng}&travelmode=walking">Directions</a>
    </div>
    ${!realGps && !inRange && !claimed ? `<div class="btns"><button class="btn blue" id="tp">🕹️ Teleport here (demo only)</button></div>` : ''}
  `, 'treasure');
  const c = $('#claim'); if (c) c.onclick = () => claimTreasure(t);
  const tp = $('#tp'); if (tp) tp.onclick = () => { setPos(offsetM(t, 12, -12)); openTreasure(t); };
}
function claimTreasure(t) {
  if (S.claimed.includes(t.id) || distM(S.pos, t) > CLAIM_RADIUS_M) return;
  const it = ITEMS[t.item];
  S.claimed.push(t.id); addItem(t.item); S.coins += t.coins; gainXp(40); save();
  treasureMarkers[t.id].setIcon(treasureIcon(t));
  renderHud();
  openSheet(`
    <div style="text-align:center">
      <div style="font-size:64px;margin:8px 0">${it.ico}</div>
      <h2>You found<br>${esc(it.name)}!</h2>
      <p>${esc(it.desc)}<br><b>+${t.coins} coins</b> · ${statLine(it)}</p>
      <div class="btns"><button class="btn primary" id="eq">Wear it now</button><button class="btn" id="later">Put in bag</button></div>
    </div>`, 'reward');
  $('#eq').onclick = () => { S.equipped[it.slot] = t.item; save(); renderHud(); openProfile(); };
  $('#later').onclick = closeSheet;
}
function statLine(it) {
  const s = [];
  if (it.atk) s.push(`+${it.atk} ATK`); if (it.def) s.push(`+${it.def} DEF`); if (it.heal) s.push(`+${it.heal} HP`);
  return s.join(' · ') || it.rarity;
}

// Nudge when you walk into range of something
const nudged = new Set();
function checkProximity() {
  if (sheetKind || inBattle) return;
  TREASURES.forEach((t) => {
    if (!S.claimed.includes(t.id) && distM(S.pos, t) <= CLAIM_RADIUS_M && !nudged.has(t.id)) {
      nudged.add(t.id);
      toast(`🧰 You're at <b>${esc(t.name)}</b>! A chest is here.`, [['Open it', 'primary', () => openTreasure(t)], ['Later', '', null]]);
    }
  });
}

// ---------- shop ----------
const SHOP_RADIUS_M = 80;
function openShop(s) {
  const d = distM(S.pos, s), here = d <= SHOP_RADIUS_M;
  openSheet(`
    <div class="row"><div style="font-size:40px">${s.ico}</div><div><h2>${esc(s.name)}</h2>
      <span class="pill ${here ? 'ok' : 'far'}">${here ? 'Open — you are here' : fmtDist(d) + ' away'}</span></div></div>
    <p>${esc(s.blurb)}</p>
    <div class="list">${s.stock.map((id) => { const it = ITEMS[id]; return `
      <div class="item"><div class="ico">${it.ico}</div><div class="grow"><b>${esc(it.name)}</b><span class="sub">${esc(it.desc)} ${statLine(it)}</span></div>
      <button class="btn gold" data-buy="${id}" ${here && S.coins >= it.price ? '' : 'disabled'}>🪙 ${it.price}</button></div>`; }).join('')}
    </div>
    ${here ? '' : `<p class="sub" style="margin-top:12px">Visit in person to buy.</p>${realGps ? '' : '<div class="btns"><button class="btn blue" id="tp">🕹️ Teleport here (demo only)</button></div>'}`}
  `, 'shop');
  sheetBody.querySelectorAll('[data-buy]').forEach((b) => (b.onclick = () => {
    const it = ITEMS[b.dataset.buy];
    if (S.coins < it.price) return;
    S.coins -= it.price; addItem(b.dataset.buy); save(); renderHud();
    toast(`Bought ${it.ico} ${esc(it.name)}`); openShop(s);
  }));
  const tp = $('#tp'); if (tp) tp.onclick = () => { setPos(offsetM(s, 10, 10)); openShop(s); };
}

// ---------- bag ----------
function openBag() {
  const ids = Object.keys(S.bag);
  openSheet(`
    <h2>🎒 Bag</h2>
    <p class="sub">Treasures found: ${S.claimed.length}/${TREASURES.length} · Tap to wear or use.</p>
    ${ids.length ? `<div class="grid">${ids.map((id) => { const it = ITEMS[id]; const on = Object.values(S.equipped).includes(id); return `
      <button class="slot ${on ? 'equipped' : ''}" data-id="${id}"><span class="ico">${it.ico}</span>${esc(it.name)}<small>${it.slot === 'use' ? '×' + S.bag[id] : statLine(it)}</small></button>`; }).join('')}</div>`
      : '<p>Empty. Find chests or visit a shop.</p>'}
  `, 'bag');
  sheetBody.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => useOrEquip(b.dataset.id, openBag)));
}
function useOrEquip(id, after) {
  const it = ITEMS[id];
  if (it.slot === 'use') {
    if (id === 'map') {
      const left = TREASURES.filter((t) => !S.claimed.includes(t.id));
      if (!left.length) return toast('No hidden treasures left!');
      const t = left.sort((a, b) => distM(S.pos, a) - distM(S.pos, b))[0];
      removeItem(id); save();
      toast(`🗺️ Nearest chest: <b>${esc(t.name)}</b> (${fmtDist(distM(S.pos, t))}). ${esc(t.hint)}`, null, 8000);
      map.flyTo([t.lat, t.lng], 15);
      closeSheet(); return;
    }
    if (S.hp >= maxHp()) return toast('HP is already full.');
    S.hp = Math.min(maxHp(), S.hp + it.heal); removeItem(id);
    toast(`${it.ico} +${it.heal} HP`);
  } else {
    S.equipped[it.slot] = S.equipped[it.slot] === id ? null : id;
  }
  save(); renderHud(); after && after();
}

// ---------- profile / character creator ----------
function openProfile() {
  const opt = (key, vals, swatch) => vals.map((v) => swatch
    ? `<button class="swatch ${S.look[key] === v ? 'sel' : ''}" style="background:${v}" data-k="${key}" data-v="${v}" aria-label="${v}"></button>`
    : `<button class="opt ${S.look[key] === v ? 'sel' : ''}" data-k="${key}" data-v="${v}">${v}</button>`).join('');
  const gear = ['hat', 'face', 'neck'].map((slot) => {
    const owned = Object.keys(S.bag).filter((id) => ITEMS[id].slot === slot);
    return `<button class="opt ${!S.equipped[slot] ? 'sel' : ''}" data-slot="${slot}" data-item="">No ${slot}</button>` +
      owned.map((id) => `<button class="opt ${S.equipped[slot] === id ? 'sel' : ''}" data-slot="${slot}" data-item="${id}">${ITEMS[id].ico} ${esc(ITEMS[id].name)}</button>`).join('');
  }).join('');
  openSheet(`
    <div class="row">
      <div class="big-avatar">${myAvatar()}</div>
      <div><h2>${esc(S.name || 'New Traveler')}</h2>
        <div class="sub">Lv${S.lvl} · XP ${S.xp}/100</div>
        <div class="sub">HP ${S.hp}/${maxHp()} · ATK ${myAtk()} · DEF ${myDef()}</div>
        <div class="sub">🪙 ${S.coins} · 🤝 ${S.friends.length} friends</div></div>
    </div>
    <label class="field">Name</label>
    <input class="text" id="name" maxlength="14" placeholder="Pick a player name" value="${esc(S.name)}">
    <label class="field">Skin</label><div class="opts">${opt('skin', AVATAR_OPTIONS.skin, true)}</div>
    <label class="field">Hair</label><div class="opts">${opt('hair', AVATAR_OPTIONS.hair)}</div>
    <label class="field">Hair color</label><div class="opts">${opt('hairColor', AVATAR_OPTIONS.hairColor, true)}</div>
    <label class="field">Outfit</label><div class="opts">${opt('shirt', AVATAR_OPTIONS.shirt, true)}</div>
    <label class="field">Gear (from treasures & shops)</label><div class="opts">${gear}</div>
    <div class="btns"><button class="btn primary" id="done">Save & explore</button></div>
    <p class="sub" style="margin-top:14px">Demo: other players are simulated. <button class="sub" id="reset" style="text-decoration:underline">Reset progress</button></p>
  `, 'profile');
  $('#name').oninput = (e) => { S.name = e.target.value.trim(); save(); renderHud(); };
  sheetBody.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => { S.look[b.dataset.k] = b.dataset.v; save(); renderHud(); openProfile(); }));
  sheetBody.querySelectorAll('[data-slot]').forEach((b) => (b.onclick = () => { S.equipped[b.dataset.slot] = b.dataset.item || null; save(); renderHud(); openProfile(); }));
  $('#done').onclick = () => { if (!S.name) S.name = 'Traveler'; save(); renderHud(); closeSheet(); };
  $('#reset').onclick = () => { if (confirm('Reset all progress?')) { try { localStorage.removeItem('questmap'); } catch {} location.reload(); } };
}

function gainXp(n) {
  S.xp += n;
  while (S.xp >= 100) { S.xp -= 100; S.lvl++; S.hp = maxHp(); toast(`⭐ Level up! You're now Lv${S.lvl}.`); }
}

// ---------- players ----------
const isFriend = (n) => S.friends.includes(n.id);
function openPlayer(n) {
  const d = distM(S.pos, n.pos), near = d <= NEARBY_RADIUS_M;
  openSheet(`
    <div class="row"><div class="big-avatar" style="width:90px;height:90px">${npcAvatar(n)}</div>
      <div><h2>${esc(n.name)}</h2><div class="sub">Lv${n.lvl} · ${fmtDist(d)} away</div>
      <div style="margin-top:6px">${isFriend(n) ? '<span class="pill ok">Friend</span>' : ''}<span class="pill ${near ? 'ok' : 'far'}">${near ? 'Nearby' : 'Too far'}</span></div></div></div>
    <p>${near ? 'Send a request. They choose whether to accept.' : `Get within ${NEARBY_RADIUS_M} m to interact.`}</p>
    <div class="btns">
      <button class="btn primary" id="rq-battle" ${near ? '' : 'disabled'}>⚔️ Battle?</button>
      <button class="btn blue" id="rq-talk" ${near ? '' : 'disabled'}>💬 Talk?</button>
    </div>
    ${isFriend(n) ? '' : `<div class="btns"><button class="btn" id="rq-friend">🤝 Add friend</button></div>`}
  `, 'player');
  $('#rq-battle').onclick = () => sendRequest(n, 'battle');
  $('#rq-talk').onclick = () => sendRequest(n, 'talk');
  const f = $('#rq-friend'); if (f) f.onclick = () => addFriend(n);
}
function sendRequest(n, kind) {
  closeSheet();
  if (kind === 'battle' && S.hp < 6) return toast('You are too hurt to battle. Heal up first (Bag → drinks).');
  const w = toast(`${kind === 'battle' ? '⚔️' : '💬'} Asked <b>${esc(n.name)}</b> to ${kind}… waiting`, null, 0);
  setTimeout(() => {
    w.remove();
    const yes = kind === 'talk' || isFriend(n) || Math.random() < 0.8;
    if (!yes) return toast(`${esc(n.name)} declined. Maybe later.`);
    toast(`${esc(n.name)} accepted!`, null, 1500);
    setTimeout(() => (kind === 'battle' ? startBattle(n) : openTalk(n)), 600);
  }, rand(1200, 2200));
}
function addFriend(n) {
  closeSheet();
  toast(`🤝 Friend request sent to ${esc(n.name)}`, null, 2000);
  setTimeout(() => { if (!isFriend(n)) S.friends.push(n.id); save(); toast(`🤝 ${esc(n.name)} is now your friend!`); }, 1800);
}

// Incoming requests from nearby "players"
function scheduleIncoming(first) {
  setTimeout(() => {
    const near = npcs.filter((n) => distM(n.pos, S.pos) <= NEARBY_RADIUS_M);
    if (!inBattle && !sheetKind && near.length && S.name) {
      const n = near[randi(0, near.length - 1)], kind = Math.random() < 0.55 ? 'battle' : 'talk';
      toast(`${kind === 'battle' ? '⚔️' : '💬'} <b>${esc(n.name)}</b> (${fmtDist(distM(n.pos, S.pos))} away) wants to ${kind === 'battle' ? 'battle' : 'talk'}!`,
        [['Accept', 'primary', () => (kind === 'battle' ? (S.hp < 6 ? toast('Too hurt to battle — heal first.') : startBattle(n)) : openTalk(n))], ['Decline', '', null]], 7000);
    }
    scheduleIncoming(false);
  }, first ? 14000 : rand(40000, 70000));
}

// ---------- friends ----------
function openFriends() {
  const row = (n) => { const d = distM(S.pos, n.pos), near = d <= NEARBY_RADIUS_M; return `
    <div class="item"><div class="mini">${npcAvatar(n)}</div><div class="grow"><b>${esc(n.name)}</b><span class="sub">Lv${n.lvl} · ${fmtDist(d)} · ${near ? '🟢 nearby' : '⚪ far'}</span></div>
    <button class="btn" data-see="${n.id}">View</button></div>`; };
  const friends = npcs.filter(isFriend), others = npcs.filter((n) => !isFriend(n)).sort((a, b) => distM(S.pos, a.pos) - distM(S.pos, b.pos));
  openSheet(`
    <h2>🤝 Friends</h2>
    ${friends.length ? `<div class="list">${friends.map(row).join('')}</div>` : '<p class="sub">No friends yet. Tap a player on the map and add them.</p>'}
    <h2 style="margin-top:18px">📡 Players near you</h2>
    <div class="list">${others.map(row).join('')}</div>
  `, 'friends');
  sheetBody.querySelectorAll('[data-see]').forEach((b) => (b.onclick = () => { const n = npcs.find((x) => x.id === b.dataset.see); map.panTo([n.pos.lat, n.pos.lng]); openPlayer(n); }));
}

// ---------- talk / trade ----------
function openTalk(n) {
  openSheet(`
    <div class="row"><div class="mini" style="width:48px;height:48px;border-radius:12px;overflow:hidden;background:#cfe8ff">${npcAvatar(n)}</div>
      <div><h2 style="margin:0">${esc(n.name)}</h2><span class="sub">Friendly chat · Lv${n.lvl}</span></div></div>
    <div class="chat" id="chat"></div>
    <div class="chips">
      <button class="chip" data-a="tip">🗺️ Any tips?</button>
      <button class="chip" data-a="trade">🔁 Trade?</button>
      ${isFriend(n) ? '' : '<button class="chip" data-a="friend">🤝 Add friend</button>'}
      <button class="chip" data-a="battle">⚔️ Battle?</button>
    </div>
    <div class="row" style="margin-top:10px"><input class="text" id="say" placeholder="Say something…" style="margin:0"><button class="btn blue" id="send" style="flex:none;min-width:0">Send</button></div>
  `, 'talk');
  const chat = $('#chat');
  const add = (who, html) => { const m = document.createElement('div'); m.className = 'msg ' + who; m.innerHTML = html; chat.appendChild(m); chat.scrollTop = chat.scrollHeight; return m; };
  const reply = (html, delay = 700) => setTimeout(() => add('them', html), delay);
  add('sys', `You're chatting with ${esc(n.name)}`);
  reply(esc(n.greet), 400);
  const send = () => {
    const v = $('#say').value.trim(); if (!v) return; $('#say').value = '';
    add('me', esc(v));
    reply(esc(['haha true', 'nice 😄', 'for real', 'same tbh', 'good luck out there!', 'lol ok ok'][randi(0, 5)]));
  };
  $('#send').onclick = send;
  $('#say').onkeydown = (e) => { if (e.key === 'Enter') send(); };
  sheetBody.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => {
    const a = b.dataset.a;
    if (a === 'tip') { add('me', 'Any tips?'); reply('💡 ' + esc(n.tip)); }
    if (a === 'friend') { add('me', 'Wanna be friends?'); b.remove(); setTimeout(() => { if (!isFriend(n)) S.friends.push(n.id); save(); add('them', 'sure! added you 🤝'); add('sys', `${esc(n.name)} is now your friend`); }, 700); }
    if (a === 'battle') { add('me', 'Wanna battle?'); setTimeout(() => { add('them', "you're on! ⚔️"); setTimeout(() => startBattle(n), 900); }, 600); }
    if (a === 'trade') {
      add('me', 'Wanna trade?');
      const give = ITEMS[n.offer], want = ITEMS[n.wants], have = !!S.bag[n.wants];
      setTimeout(() => {
        const m = add('them', `I'll give you <b>${give.ico} ${esc(give.name)}</b> for your <b>${want.ico} ${esc(want.name)}</b>.` +
          (have ? `<div class="btns" style="margin-top:8px"><button class="btn primary" style="min-width:0;padding:6px">Deal</button><button class="btn" style="min-width:0;padding:6px">No thanks</button></div>`
                : `<br><span class="sub">(You don't have a ${esc(want.name)} yet.)</span>`));
        const [ok, no] = m.querySelectorAll('button');
        if (ok) ok.onclick = () => {
          if (!S.bag[n.wants]) return;
          removeItem(n.wants); addItem(n.offer); save(); renderHud();
          m.querySelector('.btns').remove(); add('sys', `Traded ${want.ico} for ${give.ico}`); reply('pleasure doing business 🤝', 400);
        };
        if (no) no.onclick = () => { m.querySelector('.btns').remove(); reply('no worries!', 300); };
      }, 700);
    }
  }));
}

// ---------- battle ----------
let inBattle = false;
const B = {};
const bt = { text: $('#bt-text'), menu: $('#bt-menu') };
async function say(msg) {
  bt.menu.innerHTML = '';
  bt.text.textContent = '';
  for (const ch of msg) { bt.text.textContent += ch; await sleep(18); }
  await sleep(650);
}
function renderBattleBars() {
  $('#bt-enemy-hp').style.width = Math.max(0, B.eHp / B.eMax * 100) + '%';
  $('#bt-me-hp').style.width = Math.max(0, S.hp / maxHp() * 100) + '%';
  $('#bt-me-hpnum').textContent = `${Math.max(0, S.hp)}/${maxHp()}`;
}
function fx(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }

async function startBattle(n) {
  closeSheet();
  inBattle = true;
  Object.assign(B, { n, eMax: n.hp, eHp: n.hp, eAtk: n.atk, eDef: n.def, meDef: false, eDefending: false, over: false });
  $('#bt-enemy-name').textContent = n.name.toUpperCase();
  $('#bt-enemy-lv').textContent = 'Lv' + n.lvl;
  $('#bt-me-name').textContent = (S.name || 'YOU').toUpperCase();
  $('#bt-me-lv').textContent = 'Lv' + S.lvl;
  const es = $('#bt-enemy-sprite'), ms = $('#bt-me-sprite');
  es.className = 'bt-sprite enemy'; ms.className = 'bt-sprite me';
  es.innerHTML = npcAvatar(n);
  ms.innerHTML = myAvatar(); ms.style.transform = 'scaleX(-1)';
  renderBattleBars();
  $('#battle').classList.remove('hidden');
  await say(`${n.name} wants to battle!`);
  mainMenu();
}
function menu(items, wide) {
  bt.menu.className = 'bt-menu' + (wide ? ' wide' : '');
  bt.menu.innerHTML = '';
  items.forEach(([label, fn, disabled]) => {
    const b = document.createElement('button'); b.textContent = label; b.disabled = !!disabled;
    b.onclick = () => { bt.menu.innerHTML = ''; fn(); }; bt.menu.appendChild(b);
  });
  bt.menu.querySelector('button:not(:disabled)')?.focus();
}
function mainMenu() {
  bt.text.textContent = `What will ${S.name || 'you'} do?`;
  menu([['ATTACK', doAttack], ['DEFEND', doDefend], ['ACT', actMenu], ['RUN', doRun]]);
}
function actMenu() {
  bt.text.textContent = 'Act how?';
  const heal = ['bigpotion', 'potion', 'sunscreen'].find((id) => S.bag[id]);
  menu([
    ['TRUCE', doNegotiate],
    ['PRAISE', doCompliment],
    ['PAY 30', doBribe, S.coins < 30],
    [heal ? `ITEM ${ITEMS[heal].ico}` : 'ITEM', () => doHeal(heal), !heal],
    ['BACK', mainMenu],
  ]);
}
async function doAttack() {
  const crit = Math.random() < 0.12;
  let dmg = Math.max(1, myAtk() + randi(-2, 3) - B.eDef);
  if (crit) dmg = Math.round(dmg * 1.6);
  if (B.eDefending) dmg = Math.max(1, Math.floor(dmg / 2));
  await say(`${S.name || 'You'} attacked!`);
  B.eHp -= dmg; fx($('#bt-enemy-sprite'), 'flash'); renderBattleBars();
  if (crit) await say('A critical hit!');
  if (B.eDefending) await say(`${B.n.name} blocked some of it.`);
  if (B.eHp <= 0) return win();
  enemyTurn();
}
async function doDefend() {
  B.meDef = true; S.hp = Math.min(maxHp(), S.hp + 2); renderBattleBars();
  await say(`${S.name || 'You'} braced for impact! (+2 HP)`);
  enemyTurn();
}
async function doCompliment() {
  const lines = ['Nice outfit!', 'Your gear is sick.', 'You hike fast!'];
  await say(`"${lines[randi(0, 2)]}"`);
  B.eAtk = Math.max(2, B.eAtk - 1);
  await say(`${B.n.name} blushed. Their ATK fell!`);
  enemyTurn();
}
async function doNegotiate() {
  await say(`${S.name || 'You'}: "Call it a draw?"`);
  const chance = 0.2 + 0.55 * (1 - B.eHp / B.eMax) + (isFriend(B.n) ? 0.2 : 0);
  if (Math.random() < chance) {
    await say(`${B.n.name}: "Deal. Good fight."`);
    await say('The battle ended peacefully. No coins lost.');
    return endBattle();
  }
  await say(`${B.n.name}: "Not a chance!"`);
  enemyTurn();
}
async function doBribe() {
  S.coins -= 30; renderHud();
  await say(`You handed over 30 coins...`);
  await say(`${B.n.name} took the money and left.`);
  endBattle();
}
async function doHeal(id) {
  const it = ITEMS[id];
  S.hp = Math.min(maxHp(), S.hp + it.heal); removeItem(id); renderBattleBars();
  await say(`Used ${it.name}! +${it.heal} HP.`);
  enemyTurn();
}
async function doRun() {
  if (Math.random() < 0.55) { await say('Got away safely!'); return endBattle(); }
  await say("Couldn't get away!");
  enemyTurn();
}
async function enemyTurn() {
  B.eDefending = false;
  const r = Math.random();
  if (r < 0.15) { B.eDefending = true; await say(`${B.n.name} is defending!`); }
  else if (r < 0.22) { await say(`${B.n.name} is showing off their gear.`); }
  else {
    let dmg = Math.max(1, B.eAtk + randi(-2, 2) - myDef());
    if (B.meDef) dmg = Math.max(1, Math.floor(dmg / 2));
    await say(`${B.n.name} attacked!`);
    S.hp -= dmg; fx($('#bt-me-sprite'), 'shake'); renderBattleBars(); renderHud();
    if (B.meDef) await say('Your defense softened the blow.');
    if (S.hp <= 0) return lose();
  }
  B.meDef = false;
  mainMenu();
}
async function win() {
  $('#bt-enemy-sprite').classList.add('faint');
  const loot = Math.round(B.n.coins * 0.2) + 20;
  await say(`${B.n.name} was defeated!`);
  S.coins += loot; gainXp(35); renderHud();
  await say(`You won ${loot} coins!`);
  endBattle();
}
async function lose() {
  S.hp = 0; renderBattleBars();
  $('#bt-me-sprite').classList.add('faint');
  const lost = Math.floor(S.coins * 0.25);
  await say(`${S.name || 'You'} fainted!`);
  S.coins -= lost; S.hp = Math.ceil(maxHp() / 2); renderHud();
  await say(`You paid ${lost} coins to ${B.n.name}...`);
  await say('You limped back to safety.');
  endBattle();
}
function endBattle() {
  save();
  menu([['BACK TO MAP', () => { $('#battle').classList.add('hidden'); inBattle = false; renderHud(); }]], true);
}

// ---------- boot ----------
renderHud();
if (!S.name) {
  openProfile();
  toast('👋 Welcome to QuestMap LA! Make your character, then drag it around the map (or tap 📍 to use real GPS).', null, 9000);
}
checkProximity();
scheduleIncoming(true);
