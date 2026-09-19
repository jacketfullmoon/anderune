// Character drawing: builds an SVG avatar from a look + equipped gear.
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

const CHEST_SVG = `<svg viewBox="0 0 32 32" width="34" height="34"><rect x="4" y="13" width="24" height="14" rx="2" fill="#a0522d" stroke="#3b1d0e" stroke-width="2"/><path d="M4 14 Q4 5 16 5 Q28 5 28 14Z" fill="#c2692f" stroke="#3b1d0e" stroke-width="2"/><rect x="4" y="13" width="24" height="3" fill="#f5b82e" stroke="#3b1d0e" stroke-width="1"/><rect x="13.5" y="12" width="5" height="8" rx="1" fill="#f5b82e" stroke="#3b1d0e" stroke-width="1.5"/></svg>`;
