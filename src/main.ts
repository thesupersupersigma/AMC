import './css/tokens.css';
import './css/layout.css';
import './css/components.css';
import './css/views.css';
import './css/lyrics.css';

/* The log module installs the global error hooks on import — everything
   after this line is captured. */
import { logErr, refreshLogUI, toggleErrPanel, wireErrPanel } from './ui/log';
import { S, seedStateFromPrefs } from './state';
import { revokeCurrentURL } from './audio/engine';
import { media } from './audio/media';
import { releaseCovers } from './state';
import { idbOpen } from './db/idb';
import { $, isTyping } from './util';
import { addFolderViaPicker, addWebkitFolder, restoreFoldersOnBoot, wireFolderUI } from './fs/folders';
import { rescanLibrary } from './scan/scanner';
import { importM3U, loadPlaylists } from './ui/playlists';
import { navTo, wireLibrary } from './ui/render';
import { renderPlaylistNav, wireSidebar } from './ui/sidebar';
import {
  next,
  playList,
  prev,
  setVolume,
  syncVolumeUI,
  togglePlay,
  wireAudio,
  wireMediaSession,
  wirePlayerBar,
} from './ui/player';
import { toggleQueuePanel, queuePanelOpen, wireQueuePanel } from './ui/queue';
import { closeMenu, menuOpen, wireMenus } from './ui/menu';
import { wireSearch } from './ui/search';
import { wireSplitEditor, wireWaveform } from './ui/waveform';
import { openAiRepair, wireRepair } from './ui/repair';
import { wireLyrics } from './ui/lyrics';
import { wireSettings } from './ui/settings';
import { wireNowPlaying } from './ui/nowplaying';
import { wirePip } from './ui/pip';

/* =========================================================================
   Keyboard
   ========================================================================= */
let spaceGuardAt = 0;

function wireKeyboard(): void {
  document.addEventListener(
    'keydown',
    (e) => {
      /* the log panel is reachable from anywhere, including a text field */
      if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        toggleErrPanel();
        return;
      }
      if (e.key === 'Escape') {
        if (!$('#errpanel').hidden) {
          toggleErrPanel(false);
          return;
        }
        if (menuOpen()) {
          closeMenu();
          return;
        }
        if (queuePanelOpen()) {
          toggleQueuePanel(false);
          return;
        }
        if (isTyping(e.target)) {
          (e.target as HTMLElement).blur();
          return;
        }
      }
      if (isTyping(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.code === 'Space' || e.key === ' ') {
        /* Stops the page scrolling AND stops a focused button from firing.
           The capture-phase click guard below catches the synthesized click. */
        e.preventDefault();
        spaceGuardAt = performance.now();
        if (!e.repeat) togglePlay();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        navTo('search');
        $<HTMLInputElement>('#q').focus();
        $<HTMLInputElement>('#q').select();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (e.shiftKey) prev();
        else if (S.current) media.currentTime = Math.max(0, media.currentTime - 5);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (e.shiftKey) next(true);
        else if (S.current && isFinite(media.duration)) media.currentTime = Math.min(media.duration, media.currentTime + 5);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setVolume(S.volume + 0.05);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setVolume(S.volume - 0.05);
        return;
      }
    },
    true
  );

  document.addEventListener(
    'keyup',
    (e) => {
      if (e.code === 'Space' || e.key === ' ') e.preventDefault();
    },
    true
  );

  /* A keyboard-generated click has detail === 0. If one arrives right after a
     Space keydown we swallow it, so the play button never toggles twice. */
  document.addEventListener(
    'click',
    (e) => {
      if (spaceGuardAt && performance.now() - spaceGuardAt < 600 && e.detail === 0) {
        spaceGuardAt = 0;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );
}

/* =========================================================================
   Service worker updates — the plugin registers the worker; this only
   surfaces "a new version is ready" and never reloads on its own, so an
   update can never interrupt playback.
   ========================================================================= */
function wireServiceWorkerUpdates(): void {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      /* first install taking control — not an update */
      hadController = true;
      return;
    }
    $('#swUpdate').hidden = false;
  });
  $('#swReload').addEventListener('click', () => {
    location.reload();
  });
  $('#swLater').addEventListener('click', () => {
    $('#swUpdate').hidden = true;
  });
}

/* =========================================================================
   Boot
   ========================================================================= */
async function boot(): Promise<void> {
  /* The database first: prefs and the folder registry live there now. */
  await idbOpen();
  await seedStateFromPrefs();
  media.volume = S.volume;
  media.muted = S.muted;
  media.setSpatialModeProvider(() => S.spatialMode);

  $('#pickBtn').addEventListener('click', addFolderViaPicker);
  $('#addFolderBtn').addEventListener('click', addFolderViaPicker);
  $('#rescanBtn').addEventListener('click', rescanLibrary);
  $('#repairBtn').addEventListener('click', openAiRepair);
  $('#settingsBtn').addEventListener('click', () => {
    navTo('settings');
  });
  $<HTMLInputElement>('#picker').addEventListener('change', (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (files && files.length) void addWebkitFolder(files);
  });
  $<HTMLInputElement>('#m3upicker').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files && (e.target as HTMLInputElement).files![0];
    if (f)
      void f.text().then((t) => {
        importM3U(t, f.name);
      });
  });

  wireLibrary();
  wireSidebar();
  wirePlayerBar();
  wireQueuePanel();
  wireAudio();
  wireKeyboard();
  wireErrPanel();
  wireMediaSession();
  wireSearch();
  wireMenus();
  wireFolderUI();
  wireWaveform();
  wireSplitEditor();
  wireRepair();
  wireLyrics();
  wireSettings();
  wireNowPlaying();
  wirePip();
  syncVolumeUI();
  refreshLogUI();
  wireServiceWorkerUpdates();

  /* The page must not swallow a file dropped outside the sidebar. */
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
  });

  window.addEventListener('beforeunload', () => {
    revokeCurrentURL();
    releaseCovers();
  });

  try {
    await loadPlaylists();
    renderPlaylistNav();
  } catch (e) {
    logErr('startup', 'Could not load saved playlists', (e as Error) && (e as Error).message);
  }
  /* Reopen granted folders without a prompt; anything else renders as a
     one-click Reconnect (FSA) or a pick-again row (webkitdir). */
  await restoreFoldersOnBoot();
}

/* Dev builds only: a handle for the browser tests (test/browser/). The
   production and single-file builds compile this away. */
if (import.meta.env.DEV) {
  (window as unknown as { __amcDebug?: unknown }).__amcDebug = { S, media, playList, next, prev, togglePlay, setVolume };
}

void boot().catch((e: Error) => {
  logErr('startup', 'Boot failed', e && (e.stack || e.message));
});
