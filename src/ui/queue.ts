/* The Up Next panel. */

import { S } from '../state';
import { icon, artHTML } from './icons';
import { esc, clamp, $ } from '../util';
import { playAt, syncPlayerUI } from './player';
import { clearDropMarks } from './render';

export function renderQueuePanel(): void {
  const box = $('#queueList');
  if (!box) return;
  if (!S.queue.length) {
    box.innerHTML =
      '<div class="empty-note" style="padding:20px 6px"><b>The queue is empty</b>Play an album or a playlist and the running order shows up here.</div>';
    return;
  }
  let h = '';
  for (let i = 0; i < S.queue.length; i++) {
    const t = S.queue[i];
    if (i === S.qi) h += '<div class="q-sub">Now playing</div>';
    if (i === S.qi + 1) h += '<div class="q-sub">Next up</div>';
    h +=
      '<div class="qrow' + (i === S.qi ? ' now' : '') + '" data-qi="' + i + '" draggable="true">' +
      '<div class="thumb">' + artHTML(t.coverKey) + '</div>' +
      '<div class="trunc" style="flex:1;min-width:0">' +
      '<div class="qt trunc">' + esc(t.title) + '</div>' +
      '<div class="qa trunc">' + esc(t.artist) + '</div>' +
      '</div>' +
      '<span class="grip" aria-hidden="true">' + icon('grip') + '</span>' +
      '</div>';
  }
  box.innerHTML = h;
}

export function toggleQueuePanel(force?: boolean): void {
  const p = $('#upnext');
  const open = force === undefined ? !p.classList.contains('open') : force;
  p.classList.toggle('open', open);
  p.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (open) renderQueuePanel();
  $('#btnQueue').classList.toggle('on', open);
}

export function queuePanelOpen(): boolean {
  return $('#upnext').classList.contains('open');
}

export function wireQueuePanel(): void {
  const box = $('#queueList');
  let from = -1;
  box.addEventListener('click', (e) => {
    const row = (e.target as Element).closest('.qrow');
    if (!row) return;
    playAt(parseInt(row.getAttribute('data-qi') || '', 10), true);
  });
  box.addEventListener('dragstart', (e) => {
    const row = (e.target as Element).closest('.qrow');
    if (!row) return;
    from = parseInt(row.getAttribute('data-qi') || '', 10);
    try {
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', 'q' + from);
    } catch {
      /* some engines refuse dataTransfer here; the drag still works */
    }
  });
  box.addEventListener('dragover', (e) => {
    if (from < 0) return;
    const row = (e.target as Element).closest('.qrow');
    if (!row) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    clearDropMarks();
    row.classList.add(e.clientY - r.top > r.height / 2 ? 'dragover-bot' : 'dragover-top');
  });
  box.addEventListener('drop', (e) => {
    if (from < 0) return;
    const row = (e.target as Element).closest('.qrow');
    if (!row) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    let to = parseInt(row.getAttribute('data-qi') || '', 10) + (e.clientY - r.top > r.height / 2 ? 1 : 0);
    clearDropMarks();
    const cur = S.queue[S.qi];
    const item = S.queue.splice(from, 1)[0];
    if (to > from) to--;
    S.queue.splice(clamp(to, 0, S.queue.length), 0, item);
    S.qi = Math.max(0, S.queue.indexOf(cur));
    from = -1;
    renderQueuePanel();
  });
  box.addEventListener('dragend', () => {
    from = -1;
    clearDropMarks();
  });
  $('#qClose').addEventListener('click', () => {
    toggleQueuePanel(false);
  });
  $('#qClear').addEventListener('click', () => {
    const cur = S.queue[S.qi];
    S.queue = cur ? [cur] : [];
    S.baseQueue = S.queue.slice();
    S.qi = 0;
    renderQueuePanel();
    syncPlayerUI();
  });
}
