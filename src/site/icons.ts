// Small inline SVG icons in the site's drawing style (the hamster and its box): a #4A5646 outline with round joins and flat pastel fills. They replace emoji and dingbats, which render differently on every system. Every icon is decorative (aria-hidden); the text next to it carries the meaning.

const STROKE = 'stroke="#4A5646" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"';

function svg(size: number, body: string, cls = "icon"): string {
  return `<svg class="${cls}" viewBox="0 0 32 32" width="${size}" height="${size}" ${STROKE} aria-hidden="true" focusable="false">${body}</svg>`;
}

/** A handful of sunflower seeds. */
export const ICON_SEEDS = (size = 28) =>
  svg(
    size,
    `<path d="M10 6 C15 9 16 16 12 25 C7 19 6 11 10 6 Z" fill="#8B6A4A"/><path d="M10.5 9 C12 13 12 17 11.5 21" stroke="#F5E6CF" stroke-width="1.6" fill="none"/>` +
      `<path d="M21 7 C26 11 26 19 21 27 C16 20 16 12 21 7 Z" fill="#7A5A3C"/><path d="M21 10.5 C22.4 14 22.4 18.5 21.2 23" stroke="#F5E6CF" stroke-width="1.6" fill="none"/>`,
  );

/** An apple. */
export const ICON_APPLE = (size = 28) =>
  svg(
    size,
    `<path d="M16 10 C11 6 4 9 5 17 C6 24 11 28 16 26 C21 28 26 24 27 17 C28 9 21 6 16 10 Z" fill="#F6A8A0"/>` +
      `<path d="M16 10 C16 7 17 5 19 3.5" fill="none"/><path d="M17.5 7 C19 4 23 4 25 5.5 C23 8.5 20 8.8 17.5 7 Z" fill="#BFE3C0"/>` +
      `<path d="M9.5 15 C9.8 13.5 10.8 12.5 12 12" stroke="#fff" stroke-width="1.8" fill="none"/>`,
  );

/** A slice of strawberry cake. */
export const ICON_CAKE = (size = 28) =>
  svg(
    size,
    `<path d="M4 16 L28 16 L28 27 L4 27 Z" fill="#FFF3E2"/><path d="M4 21 L28 21" stroke="#F6C3BE" stroke-width="2.4"/>` +
      `<path d="M4 16 C7 12 25 12 28 16 Z" fill="#FFFFFF"/><path d="M13 12 C13 8 19 8 19 12 Z" fill="#F08A84"/><path d="M15 8.5 L16 6.5 L17 8.5" fill="none" stroke="#7DB57F"/>`,
  );

/** A little nest (a house). */
export const ICON_NEST = (size = 28) =>
  svg(
    size,
    `<path d="M6 14 L16 5 L26 14 L26 27 L6 27 Z" fill="#F5D3A6"/><path d="M3.5 15.5 L16 4.5 L28.5 15.5" fill="none"/>` +
      `<path d="M13 27 L13 20 C13 18.3 19 18.3 19 20 L19 27" fill="#FFFFFF"/><circle cx="21.5" cy="15.5" r="2" fill="#F6C3BE"/>`,
  );

/** A five-petal flower (the site's ✿, drawn). */
export const ICON_FLOWER = (size = 18) =>
  svg(
    size,
    `<g fill="#F6C3BE"><circle cx="16" cy="8.5" r="5"/><circle cx="23.2" cy="13.7" r="5"/><circle cx="20.4" cy="22.3" r="5"/><circle cx="11.6" cy="22.3" r="5"/><circle cx="8.8" cy="13.7" r="5"/></g><circle cx="16" cy="16" r="3.6" fill="#F5D3A6"/>`,
  );

/** A four-pointed sparkle (the site's ✦, drawn). */
export const ICON_SPARKLE = (size = 18) =>
  svg(size, `<path d="M16 3 C17 12 20 15 29 16 C20 17 17 20 16 29 C15 20 12 17 3 16 C12 15 15 12 16 3 Z" fill="#BFE3C0"/>`);

/** A heart in the logo's pink. */
export const ICON_HEART = (size = 16) =>
  svg(
    size,
    `<path d="M16 27 C9 21.5 4 17.5 4 11.5 C4 7.5 7 5 10.5 5 C13 5 15 6.5 16 8.5 C17 6.5 19 5 21.5 5 C25 5 28 7.5 28 11.5 C28 17.5 23 21.5 16 27 Z" fill="#F6C3BE"/>`,
  );

/** A chain link (the paste-a-link field), in the colour of the text around it. */
export const ICON_LINK = (size = 18) =>
  `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10 14 a4 4 0 0 0 5.7 0 l3-3 a4 4 0 0 0 -5.7-5.7 l-1.2 1.2"/><path d="M14 10 a4 4 0 0 0 -5.7 0 l-3 3 a4 4 0 0 0 5.7 5.7 l1.2-1.2"/></svg>`;

/** A magnifying glass (search fields), in the colour of the text around it. */
export const ICON_SEARCH = (size = 16) =>
  `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 L20 20"/></svg>`;
