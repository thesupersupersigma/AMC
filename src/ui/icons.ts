/* Every glyph is inline SVG written here. No network, ever. */

import { esc } from '../util';
import { coverURL } from '../state';

const ICONS: Record<string, string> = {
  search:   '<circle cx="11" cy="11" r="7"/><path d="M20.4 20.4l-3.9-3.9"/>',
  home:     '<path d="M3.4 11.2L12 4.2l8.6 7"/><path d="M5.6 10.1V19a1 1 0 001 1h3.2v-5h4.4v5h3.2a1 1 0 001-1v-8.9"/>',
  albums:   '<rect x="3" y="3" width="18" height="18" rx="4.5"/><circle cx="12" cy="12" r="3.1"/><circle cx="12" cy="12" r=".7" fill="currentColor" stroke="none"/>',
  artists:  '<circle cx="12" cy="8.2" r="3.9"/><path d="M4.6 20c.5-3.9 3.6-6 7.4-6s7 2.1 7.4 6"/>',
  songs:    '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  note:     '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  play:     '<path d="M7 4.5l13 7.5-13 7.5z"/>',
  pause:    '<rect x="6.5" y="4.8" width="4" height="14.4" rx="1.1"/><rect x="13.5" y="4.8" width="4" height="14.4" rx="1.1"/>',
  prev:     '<path d="M19 5.2v13.6L8.6 12z"/><rect x="4.6" y="5.2" width="3.1" height="13.6" rx="1.1"/>',
  next:     '<path d="M5 5.2v13.6L15.4 12z"/><rect x="16.3" y="5.2" width="3.1" height="13.6" rx="1.1"/>',
  shuffle:  '<path d="M3 6.5h3.4c1.3 0 2.5.6 3.2 1.7l4.8 7.6c.7 1.1 1.9 1.7 3.2 1.7H21"/><path d="M18.2 14.3L21 17.5l-2.8 3.2"/><path d="M3 17.5h3.4c1.3 0 2.5-.6 3.2-1.7l.8-1.2"/><path d="M13.4 9.4l.8-1.2c.7-1.1 1.9-1.7 3.2-1.7H21"/><path d="M18.2 3.3L21 6.5l-2.8 3.2"/>',
  repeat:   '<path d="M4 10.4V9a3.4 3.4 0 013.4-3.4h9.2"/><path d="M14 2.6l3 3-3 3"/><path d="M20 13.6V15a3.4 3.4 0 01-3.4 3.4H7.4"/><path d="M10 21.4l-3-3 3-3"/>',
  queue:    '<path d="M3 6.5h11"/><path d="M3 12h11"/><path d="M3 17.5h7"/><circle cx="17.5" cy="17" r="2.6"/><path d="M20.1 17V9.2l3-.7"/>',
  vol:      '<path d="M4 9.3h3.3L12 5.2v13.6L7.3 14.7H4z"/><path d="M15.9 9.4a3.7 3.7 0 010 5.2"/><path d="M18.5 6.8a7.4 7.4 0 010 10.4"/>',
  volmute:  '<path d="M4 9.3h3.3L12 5.2v13.6L7.3 14.7H4z"/><path d="M16.5 9.8l4.5 4.4"/><path d="M21 9.8l-4.5 4.4"/>',
  more:     '<circle cx="5.4" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.6" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  plus:     '<path d="M12 5v14"/><path d="M5 12h14"/>',
  chev:     '<path d="M9 5l7 7-7 7"/>',
  close:    '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  check:    '<path d="M4.5 12.5l5 5 10-11"/>',
  trash:    '<path d="M4 6.5h16"/><path d="M9.5 6.5V4.8a1 1 0 011-1h3a1 1 0 011 1v1.7"/><path d="M6.4 6.5l.9 12.8a1.6 1.6 0 001.6 1.4h6.2a1.6 1.6 0 001.6-1.4l.9-12.8"/>',
  pencil:   '<path d="M15.6 4.4l4 4"/><path d="M4 20l.9-3.9L15.2 5.8a1.7 1.7 0 012.4 0l.6.6a1.7 1.7 0 010 2.4L7.9 19.1z"/>',
  download: '<path d="M12 3.6v11.2"/><path d="M7.6 10.6L12 15l4.4-4.4"/><path d="M4.4 18.4v1.2a1 1 0 001 1h13.2a1 1 0 001-1v-1.2"/>',
  warn:     '<path d="M12 9v4.4"/><circle cx="12" cy="16.9" r=".95" fill="currentColor" stroke="none"/><path d="M10.3 4.1L2.6 17.5A2 2 0 004.3 20.5h15.4a2 2 0 001.7-3L13.7 4.1a2 2 0 00-3.4 0z"/>',
  grip:     '<path d="M8.5 7h.01"/><path d="M8.5 12h.01"/><path d="M8.5 17h.01"/><path d="M15.5 7h.01"/><path d="M15.5 12h.01"/><path d="M15.5 17h.01"/>',
  folder:   '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  playnext: '<path d="M3 6.5h11"/><path d="M3 12h8"/><path d="M3 17.5h8"/><path d="M15 9.4l6 3.4-6 3.4z"/>',
  lyrics:   '<path d="M4 4.5h16a1 1 0 011 1v9.5a1 1 0 01-1 1h-7.6L8 20v-4H4a1 1 0 01-1-1V5.5a1 1 0 011-1z"/><path d="M7 8.5h10"/><path d="M7 11.8h6.5"/>',
  minus:    '<path d="M5 12h14"/>',
  sortup:   '<path d="M6 14l6-6 6 6"/>',
  sortdown: '<path d="M6 10l6 6 6-6"/>',
};

export function icon(name: string, cls?: string): string {
  return '<svg class="ic ' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (ICONS[name] || '') + '</svg>';
}
export function solid(name: string, cls?: string): string {
  return icon(name, 'solid ' + (cls || ''));
}

/** Cover image if we have one, placeholder glyph otherwise. */
export function artHTML(coverKey: string, phIcon?: string): string {
  const u = coverURL(coverKey);
  if (u) return '<img src="' + esc(u) + '" alt="">';
  return '<div class="ph">' + icon(phIcon || 'note') + '</div>';
}
