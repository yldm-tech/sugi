// Hamster artwork from the design, as inline SVG. Presentation attributes only (no style attributes) so the page CSP can stay strict; the browser script animates the parts that carry ids or classes.

export const LOGO = `<svg class="logo" viewBox="0 0 48 44" width="44" height="40" stroke="#4A5646" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
<path d="M24.5 13 C24.3 9 25 6 27 3" fill="none"/>
<ellipse cx="22" cy="7.5" rx="3.6" ry="2.1" transform="rotate(-35 22 7.5)" fill="#8DCB97"/>
<ellipse cx="29" cy="6" rx="3.6" ry="2.1" transform="rotate(30 29 6)" fill="#9DD3A5"/>
<circle cx="11" cy="18" r="5" fill="#FFFFFF"/><circle cx="37" cy="18" r="5" fill="#FFFFFF"/>
<circle cx="11" cy="18" r="2.2" fill="#F6C3BE" stroke="none"/><circle cx="37" cy="18" r="2.2" fill="#F6C3BE" stroke="none"/>
<path d="M5 42 C4 24 13 14 24 14 C35 14 44 24 43 42 Z" fill="#FFFFFF"/>
<ellipse cx="17.5" cy="28" rx="2" ry="2.6" fill="#3F4A3C" stroke="none"/><ellipse cx="30.5" cy="28" rx="2" ry="2.6" fill="#3F4A3C" stroke="none"/>
<ellipse cx="13" cy="33" rx="3.2" ry="1.9" fill="#F6C3BE" stroke="none"/><ellipse cx="35" cy="33" rx="3.2" ry="1.9" fill="#F6C3BE" stroke="none"/>
<path d="M21.5 32 Q22.75 33.6 24 32 Q25.25 33.6 26.5 32" fill="none" stroke-width="1.6"/>
</svg>`;

export const HEART = `<svg viewBox="0 0 16 14" width="13" height="12" aria-hidden="true"><path d="M8 13 C3 9.5 0.5 7 0.5 4.2 C0.5 2 2.2 0.5 4.2 0.5 C5.8 0.5 7.2 1.5 8 2.8 C8.8 1.5 10.2 0.5 11.8 0.5 C13.8 0.5 15.5 2 15.5 4.2 C15.5 7 13 9.5 8 13 Z" fill="#F4A6A0"/></svg>`;

export const MOON = `<svg class="theme-night" viewBox="0 0 24 24" width="20" height="20" fill="#BFD3EE" stroke="#4A5646" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z"/></svg>`;
export const SUN = `<svg class="theme-day" viewBox="0 0 24 24" width="20" height="20" fill="#F5D3A6" stroke="#4A5646" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.2 5.2l1.8 1.8M17 17l1.8 1.8M5.2 18.8 7 17M17 7l1.8-1.8" fill="none" stroke-linecap="round"/></svg>`;

// The big hamster in the box on the home page. Ids are the hooks for app.ts (mood, outfits, eye tracking).
export function mascotStage(bubble: string, pokeTitle: string): string {
  return `<div class="stage" id="stage">
<div class="bubble" id="bubble">${bubble}</div>
<div class="mascot" id="mascot" title="${pokeTitle}" role="button" tabindex="-1">
<svg viewBox="0 0 200 132" width="200" height="132" stroke="#4A5646" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
<g id="m-sprout" class="layer">
<path d="M101 40 C100 30 102 20 108 10" fill="none"/>
<ellipse cx="94" cy="26" rx="8" ry="4.5" transform="rotate(-35 94 26)" fill="#8DCB97"/>
<ellipse cx="113" cy="22" rx="8" ry="4.5" transform="rotate(30 113 22)" fill="#9DD3A5"/>
<ellipse cx="109" cy="8" rx="7" ry="4" transform="rotate(-60 109 8)" fill="#B4DEB9"/>
</g>
<circle class="fur" cx="62" cy="58" r="12" fill="#FFFFFF"/>
<circle class="fur" cx="138" cy="58" r="12" fill="#FFFFFF"/>
<circle cx="62" cy="58" r="5.5" fill="#F6C3BE" stroke="none"/>
<circle cx="138" cy="58" r="5.5" fill="#F6C3BE" stroke="none"/>
<g class="puff l" id="m-puff-l"><ellipse class="fur" cx="44" cy="104" rx="16" ry="14" fill="#FFFFFF"/></g>
<g class="puff r" id="m-puff-r"><ellipse class="fur" cx="156" cy="104" rx="16" ry="14" fill="#FFFFFF"/></g>
<path class="fur" d="M42 132 C38 72 64 46 100 46 C136 46 162 72 158 132 Z" fill="#FFFFFF"/>
<path d="M84 56 C90 51 110 51 116 56" fill="none" stroke="#EADFC9" stroke-width="5"/>
<g class="eyes" id="m-eyes"><g id="m-open" class="layer">
<ellipse class="eye" cx="80" cy="84" rx="5" ry="6.5" fill="#3F4A3C" stroke="none"/>
<ellipse class="eye" cx="120" cy="84" rx="5" ry="6.5" fill="#3F4A3C" stroke="none"/>
<circle cx="78.3" cy="81.5" r="1.9" fill="#FFFFFF" stroke="none"/>
<circle cx="118.3" cy="81.5" r="1.9" fill="#FFFFFF" stroke="none"/>
</g></g>
<g id="m-happy" class="layer" opacity="0" fill="none" stroke-width="3"><path d="M73 87 Q80 78 87 87"/><path d="M113 87 Q120 78 127 87"/></g>
<g id="m-sleep" class="layer" opacity="0" fill="none" stroke-width="3"><path d="M73 84 Q80 90 87 84"/><path d="M113 84 Q120 90 127 84"/></g>
<path id="m-sweat" class="layer" opacity="0" d="M146 64 Q151 72 146 76 Q141 72 146 64 Z" fill="#CFE6F5" stroke-width="2"/>
<g class="blush"><ellipse cx="68" cy="96" rx="8.5" ry="5" fill="#F6C3BE" stroke="none"/></g>
<g class="blush"><ellipse cx="132" cy="96" rx="8.5" ry="5" fill="#F6C3BE" stroke="none"/></g>
<path d="M98 90 L102 90 L100 92.5 Z" fill="#4A5646" stroke-width="2"/>
<path id="m-mouth" d="M93 95 Q96.5 99 100 95 Q103.5 99 107 95" fill="none" stroke-width="2.5"/>
<g id="m-scarf" class="layer" opacity="0">
<path d="M45 104 Q100 116 155 104 L157 116 Q100 129 43 116 Z" fill="#F4A6A0"/>
<path d="M62 109 L60 120 M80 112 L79 123 M100 113 L100 124 M120 112 L121 123 M138 109 L140 120" fill="none" stroke="#FFFFFF" stroke-width="2.5"/>
<circle cx="134" cy="117" r="6" fill="#F4A6A0"/>
</g>
<g id="m-hat" class="layer" opacity="0">
<path id="m-hat-body" d="M66 58 C68 32 92 14 118 15 C138 16 151 28 156 44 C147 37 137 36 131 42 L134 58 Z" fill="#E8746C"/>
<path id="m-hat-stripe" d="M92 26 C96 34 98 46 98 56 M114 18 C118 30 120 44 119 56" fill="none" stroke="#FFFFFF" stroke-width="4" opacity="0"/>
<rect x="60" y="51" width="80" height="13" rx="6.5" fill="#FFFFFF"/>
<circle cx="157" cy="46" r="7.5" fill="#FFFFFF"/>
</g>
</svg>
</div>
<svg class="box" viewBox="0 0 200 60" width="200" height="60" stroke="#4A5646" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
<rect x="30" y="16" width="140" height="42" rx="8" fill="#EDC28E"/>
<path d="M32 31 H168 M32 45 H168" fill="none" stroke="#CF9A62" stroke-width="2.5"/>
<rect x="24" y="6" width="152" height="16" rx="7" fill="#F5D3A6"/>
<g class="paws" id="m-paws">
<ellipse class="fur" cx="74" cy="8" rx="11" ry="7.5" fill="#FFFFFF"/>
<ellipse class="fur" cx="126" cy="8" rx="11" ry="7.5" fill="#FFFFFF"/>
<path d="M71 6 V10 M77 6 V10 M123 6 V10 M129 6 V10" fill="none" stroke-width="1.8"/>
</g>
<rect x="82" y="29" width="36" height="20" rx="6" fill="#FFFFFF" stroke-width="2.5"/>
<text x="100" y="43.5" text-anchor="middle" font-family="Fredoka, sans-serif" font-weight="700" font-size="12" fill="#4A5646" stroke="none">sugi</text>
<g id="m-cny" class="fest" opacity="0" pointer-events="none">
<rect x="83" y="14" width="34" height="42" rx="5" fill="#E8574F"/>
<path d="M83 22 Q100 34 117 22" fill="none" stroke="#B93C36" stroke-width="2.5"/>
<circle cx="100" cy="30" r="7" fill="#F5C452" stroke-width="2"/>
<text x="100" y="33.6" text-anchor="middle" font-weight="900" font-size="9" fill="#B93C36" stroke="none">福</text>
</g>
<g id="m-hal" class="fest" opacity="0" pointer-events="none">
<path d="M26 30 C27 25 30 23 33 22" fill="none" stroke-width="3"/>
<ellipse cx="26" cy="45" rx="19" ry="14" fill="#F39A4A"/>
<path d="M26 31 C20 38 20 52 26 59 M26 31 C32 38 32 52 26 59" fill="none" stroke="#D47A2E" stroke-width="2"/>
<path d="M17 41 L21 44 L17 46 Z M35 41 L31 44 L35 46 Z" fill="#4A5646" stroke-width="1.5"/>
<path d="M18 51 Q26 56 34 51" fill="none" stroke-width="2"/>
</g>
</svg>
<div class="fx" id="fx"></div>
</div>`;
}

// Small hamster face used for the uploader runner, the QR badge and nudges.
export function hamsterFace(width: number, height: number, strokeWidth: number, extra = ""): string {
  return `<svg viewBox="0 0 48 44" width="${width}" height="${height}" stroke="#4A5646" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="18" r="5" fill="#FFFFFF"/><circle cx="37" cy="18" r="5" fill="#FFFFFF"/><path d="M5 42 C4 24 13 14 24 14 C35 14 44 24 43 42 Z" fill="#FFFFFF"/><ellipse cx="17.5" cy="28" rx="2.2" ry="2.8" fill="#3F4A3C" stroke="none"/><ellipse cx="30.5" cy="28" rx="2.2" ry="2.8" fill="#3F4A3C" stroke="none"/><ellipse cx="12.5" cy="34" rx="3.4" ry="2" fill="#F6C3BE" stroke="none"/><ellipse cx="35.5" cy="34" rx="3.4" ry="2" fill="#F6C3BE" stroke="none"/>${extra}</svg>`;
}

// Hamster peeking over a card (file page, login).
export function peekHamster(width: number, height: number, happy: boolean): string {
  const eyes = happy
    ? `<path d="M14 28 Q17.5 24 21 28 M27 28 Q30.5 24 34 28" fill="none" stroke-width="1.8"/><ellipse cx="12" cy="32" rx="3.2" ry="1.9" fill="#F6C3BE" stroke="none"/><ellipse cx="36" cy="32" rx="3.2" ry="1.9" fill="#F6C3BE" stroke="none"/>`
    : `<ellipse cx="17.5" cy="28" rx="2" ry="2.6" fill="#3F4A3C" stroke="none"/><ellipse cx="30.5" cy="28" rx="2" ry="2.6" fill="#3F4A3C" stroke="none"/>`;
  return `<svg viewBox="0 0 48 44" width="${width}" height="${height}" stroke="#4A5646" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
<path d="M24.5 13 C24.3 9 25 6 27 3" fill="none"/>
<ellipse cx="22" cy="7.5" rx="3.6" ry="2.1" transform="rotate(-35 22 7.5)" fill="#8DCB97"/>
<ellipse cx="29" cy="6" rx="3.6" ry="2.1" transform="rotate(30 29 6)" fill="#9DD3A5"/>
<circle cx="11" cy="18" r="5" fill="#FFFFFF"/><circle cx="37" cy="18" r="5" fill="#FFFFFF"/>
<circle cx="11" cy="18" r="2.2" fill="#F6C3BE" stroke="none"/><circle cx="37" cy="18" r="2.2" fill="#F6C3BE" stroke="none"/>
<path d="M5 42 C4 24 13 14 24 14 C35 14 44 24 43 42 Z" fill="#FFFFFF"/>
${eyes}
</svg>`;
}

export const LOST_HAMSTER = `<svg viewBox="0 0 48 44" width="180" height="165" stroke="#4A5646" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
<path d="M24.5 13 C24.3 9 25 6 27 3" fill="none"/>
<ellipse cx="22" cy="7.5" rx="3.6" ry="2.1" transform="rotate(-35 22 7.5)" fill="#8DCB97"/>
<ellipse cx="29" cy="6" rx="3.6" ry="2.1" transform="rotate(30 29 6)" fill="#9DD3A5"/>
<circle cx="11" cy="18" r="5" fill="#FFFFFF"/><circle cx="37" cy="18" r="5" fill="#FFFFFF"/>
<circle cx="11" cy="18" r="2.2" fill="#F6C3BE" stroke="none"/><circle cx="37" cy="18" r="2.2" fill="#F6C3BE" stroke="none"/>
<path d="M5 42 C4 24 13 14 24 14 C35 14 44 24 43 42 Z" fill="#FFFFFF"/>
<circle cx="17.5" cy="28" r="1.6" fill="#3F4A3C" stroke="none"/><circle cx="30.5" cy="28" r="1.6" fill="#3F4A3C" stroke="none"/>
<ellipse cx="13" cy="33" rx="3.2" ry="1.9" fill="#F6C3BE" stroke="none"/><ellipse cx="35" cy="33" rx="3.2" ry="1.9" fill="#F6C3BE" stroke="none"/>
<ellipse cx="24" cy="34" rx="1.6" ry="1.9" fill="none" stroke-width="1.2"/>
<path d="M39 22 Q41 26 39 28 Q37 26 39 22 Z" fill="#CFE6F5" stroke-width="1"/>
</svg>`;
