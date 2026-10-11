// ── FIREBASE CONFIGURATION ───────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyCIUl2p-sWCJYtXUPq2oaRWQ2qQoRA_JU4",
  authDomain: "zonetune-f1c8e.firebaseapp.com",
  projectId: "zonetune-f1c8e",
  storageBucket: "zonetune-f1c8e.firebasestorage.app",
  messagingSenderId: "956136154749",
  appId: "1:956136154749:web:3fa11f3a19e3973b203314"
};


const SP_CLIENT_ID = 'e3398d1a2bb140299e744f2d8e0cf8dd';
// Keep the path so the redirect works when hosted in a subfolder (e.g. GitHub Pages /ZoneTune/)
const SP_REDIRECT_URI = window.location.origin + window.location.pathname.replace(/index\.html$/, '');
const SP_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  // Spotify library browser (pick songs from your playlists / Liked Songs)
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'user-library-modify', // ♥ songs into Liked Songs from the library browser
].join(' ');

let spotifyToken = null;
let spotifyPlayer = null;
let spotifyDeviceId = null;
let playerReady = false;
let spotifyPlayerError = null;  // why the Web Playback SDK isn't usable (shown to the user)
let pendingSpotifyTrack = null; // track requested before the player was ready
let currentlyPlaying = false;
let progressTimer = null;
let trackDuration = 0;
let trackPosition = 0;
let scWidget = null;
let scReady = false;
let scPlaying = false;
let pendingScVolume = 1;
let scFadeInTo = null;          // volume to fade a just-loaded SoundCloud song up to once it starts
let fadeInNextTrack = false;    // the next song to start is the first after entering a zone


// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const provider = new firebase.auth.GoogleAuthProvider();

// The function called by your HTML button
function googleLogin() {
  auth.signInWithPopup(provider).catch(console.error);
}

function googleLogout() {
  auth.signOut();
}

// ── PALETTE ──────────────────────────────────────────────────────────────────
const COLORS = ['#c8ff47','#47cfff','#ff5f5f','#ffd166','#c77dff','#ff9f1c','#06d6a0','#ef476f'];
const SC_CLIENT_ID = 'L8SGpVAf1pxzBWSkGWrt01k6lOcsa1EZ';
const MAX_ZONE_TRACKS = 100;
const SPOTIFY_ICON_PATH = 'M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424a.622.622 0 01-.857.207c-2.348-1.435-5.304-1.76-8.785-.964a.622.622 0 11-.277-1.215c3.809-.87 7.076-.496 9.712 1.115a.623.623 0 01.207.857zm1.223-2.722a.78.78 0 01-1.072.257c-2.687-1.652-6.785-2.13-9.965-1.166a.78.78 0 01-.973-.519.781.781 0 01.52-.972c3.633-1.102 8.147-.568 11.233 1.328a.78.78 0 01.257 1.072zm.105-2.835C14.692 8.95 9.375 8.775 6.297 9.71a.937.937 0 11-.543-1.795c3.528-1.068 9.396-.862 13.105 1.333a.938.938 0 01-.945 1.619z';

// ── PERSISTENCE ───────────────────────────────────────────────────────────────
async function saveZones() {
  const user = auth.currentUser;
  if (!user) return; // Don't save if no one is logged in

  console.log(zones);

  const cloudData = zones.map(z => ({
    id: z.id,
    name: z.name,
    color: z.color,
    shuffle: z.shuffle || false,
    groupId: z.groupId ?? null,
    artChoice: z.artChoice ?? null,
    geoData: z.layer ? JSON.stringify(z.layer.toGeoJSON()) : null,
    playlist: (z.playlist || []).map(t => ({
      url: t.url || '',
      label: t.label || '',
      type: t.type || 'spotify',
      uri: t.uri || null,
      permalink: t.permalink || null,
      artworkUrl: t.artworkUrl || null,
      trackId: t.trackId || null,
      volume: t.volume ?? 100,
    })),
  }));

  try {
    await db.collection("users").doc(user.uid).set({
      savedZones: cloudData,
      savedGroups: groups,
      nextId: nextId,
      nextGroupId: nextGroupId
    });
  } catch (error) {
    console.error("Error saving to cloud:", error);
  }
}


// ── QUEUE MANAGER ─────────────────────────────────────────────────────────────
let queue = [];
let queueIndex = -1;

// With shuffle on, a zone's order is picked ahead of time when something needs to know it (the
// zone's popup names the song that will play first); entering the zone then uses that order.
const plannedQueues = new Map();   // zone id → order to play in the next time the zone starts

function upcomingQueue(z) {
  if (!z.shuffle) return [...z.playlist];
  const plan = plannedQueues.get(z.id);
  if (plan && plan.length === z.playlist.length && plan.every(t => z.playlist.includes(t))) return plan;
  const fresh = shuffleArray(z.playlist);
  plannedQueues.set(z.id, fresh);
  return fresh;
}

function buildQueue(z) {
  queue = upcomingQueue(z);
  plannedQueues.delete(z.id);   // the next visit gets a fresh shuffle
  queueIndex = -1;
}

// The song a zone is playing, or the one it will start with when the person walks in
function zoneCurrentTrack(z) {
  if (!z.playlist?.length) return null;
  if (musicZoneId === z.id && queue.length) return queue[Math.max(queueIndex, 0)];
  return upcomingQueue(z)[0];
}

async function advanceQueue() {
  queueIndex++;
  if (queueIndex >= queue.length) {
    // Past the zone's last song: loop back to the first (with shuffle on, in a fresh order)
    const z = getZone(musicZoneId);
    if (z?.shuffle && z.playlist.length > 1) {
      const last = queue[queue.length - 1];
      queue = shuffleArray(z.playlist);
      if (queue[0] === last) queue.push(queue.shift());   // never the same song twice in a row
    } else if (z) {
      queue = [...z.playlist];
    }
    queueIndex = 0;
  }
  await playQueueItem(queue[queueIndex]);
}

<<<<<<< HEAD
// While the next song starts after one ended, the zone keeps glowing instead of flickering off
let glowHoldUntil = 0;

// A song finished by itself: play the next one, unless the person has left (or is leaving) its zone
function autoAdvance() {
  if (musicZoneId == null || musicZoneId !== currentZoneId) return;
  glowHoldUntil = performance.now() + 4000;
  setTimeout(updateZoneGlow, 4000);   // lets the glow go if the next song never starts
  advanceQueue();
}

// The playing zone's songs or shuffle setting changed: keep the current song playing and redo what
// comes after it, so added songs get played and removed ones don't
function refreshQueue(z) {
  if (!z || z.id !== musicZoneId) return;
  const current = queue[queueIndex];
  if (!z.shuffle) {
    const oldIndex = queueIndex;
    queue = [...z.playlist];
    queueIndex = queue.indexOf(current);
    if (queueIndex < 0 && current) {
      // The playing song was removed: it plays to the end, then the song that took its place
      queueIndex = Math.min(oldIndex, queue.length);
      queue.splice(queueIndex, 0, current);
    }
  } else {
    // Songs already played this round (and the current one) stay; the rest are shuffled after them
    const done = queue.slice(0, queueIndex + 1).filter(t => t === current || z.playlist.includes(t));
    queue = done.concat(shuffleArray(z.playlist.filter(t => !done.includes(t))));
    queueIndex = done.length - 1;
=======
// ── ZONE PLAYBACK GUARD ───────────────────────────────────────────────────────
// zoneGen changes every time the person's zone changes, and playGen/playType record
// which zoneGen the current music was started for and on which player. Music that
// starts for a zone the person has already left (a play request or SoundCloud load
// still in flight when they walked out), or on the other player, is paused the
// moment it starts playing.
let zoneGen = 0;
let playGen = 0;
let playType = null; // 'spotify' | 'soundcloud'; null until something has been played

function mayPlay(type) {
  return playGen === zoneGen && (!playType || playType === type);
}
// Zone starts run one at a time, so a slow start for the zone the person just
// left can't land after the next zone's start and play the wrong zone's music
let playbackChain = Promise.resolve();

function queuePlayback(fn) {
  const run = playbackChain.then(fn);
  // A hung request must not block every later zone
  playbackChain = Promise.race([run, new Promise(r => setTimeout(r, 10000))]).catch(() => {});
  return run;
}

// Stops both players. Spotify is asked for its real state: currentlyPlaying stays
// false until a play request has finished starting up.
function stopZoneMusic() {
  pendingSpotifyTrack = null;
  if (scWidget && scReady) scWidget.pause();
  if (spotifyPlayer) {
    spotifyPlayer.getCurrentState()
      .then(state => { if (state && !state.paused) return spotifyPlayer.pause(); })
      .catch(() => {});
>>>>>>> 312b56b1fca426800ef113477e8718c43aa81485
  }
}

async function playQueueItem(track) {
  if (!track) return;
<<<<<<< HEAD
  stopVolumeRamp();
  const vol = track.volume ?? 100;
  const fadeIn = fadeInNextTrack;   // first song after entering a zone starts silent and fades in
  syncVolumeSlider(vol);
=======
  // This music belongs to the person's current zone
  playGen = zoneGen;
  playType = track.type;
  const vol = (track.volume ?? 100) / 100;
  syncVolumeSlider(track.volume ?? 100);
>>>>>>> 312b56b1fca426800ef113477e8718c43aa81485
  if (track.type === 'spotify') {
    if (scWidget && scReady) scWidget.pause();
    // The Spotify device only exists once the Web Playback SDK fires 'ready'.
    // Previously the request was silently dropped here and never retried, so a
    // zone entered while the player wasn't ready stayed silent forever.
    if (!playerReady || !spotifyDeviceId) {
      pendingSpotifyTrack = track;
      if (!spotifyToken) {
        showToast('Connect Spotify to play music');
        document.getElementById('spOverlay').classList.remove('hidden');
      } else if (spotifyPlayerError) {
        showToast('Spotify player unavailable: ' + spotifyPlayerError, 6000);
      } else {
        showToast('Spotify player is still connecting — music will start when it is ready', 4000);
      }
      return;   // fadeInNextTrack stays set, so the deferred start still fades in
    }
    pendingSpotifyTrack = null;
    fadeInNextTrack = false;
    await setPlayerVolume('spotify', fadeIn ? 0 : vol);
    await playTrackList([track.uri]);
    if (fadeIn) rampVolume('spotify', vol);
  } else if (track.type === 'soundcloud') {
    pendingSpotifyTrack = null;
    fadeInNextTrack = false;
    if (spotifyPlayer && currentlyPlaying) await spotifyPlayer.pause();
    pendingScVolume = fadeIn ? 0 : vol;
    scFadeInTo = fadeIn ? vol : null;   // the ramp starts on the widget's PLAY event
    playSoundcloudTrack(track);
  }
}

function syncVolumeSlider(val) {
  const npVol = document.getElementById('npVol');
  if (npVol) npVol.value = val;
}

function playSoundcloudTrack(track) {
  console.log('playSoundcloudTrack called', track);
  console.log('scWidget:', scWidget, 'scReady:', scReady);
  if (!scWidget || !scReady) { showToast('SoundCloud player not ready'); return; }
  scWidget.setVolume(pendingScVolume);   // so a fading-in song doesn't blip at the old volume
  scWidget.load(track.permalink, {
    auto_play: true,
    buying: false, liking: false, download: false,
    sharing: false, show_artwork: false,
    show_comments: false, show_user: false,
  });
}

async function loadZonesFromCloud(uid) {
  try {
    const doc = await db.collection("users").doc(uid).get();
    
    if (doc.exists) {
      const data = doc.data();
      nextId = data.nextId || 3;
      nextGroupId = data.nextGroupId || 1;
      groups = data.savedGroups || [];
      
      drawnItems.clearLayers(); // Clear map before redrawing
      
      zones = data.savedZones.map(cloudZone => {
        let restoredLayer = null;
        
        // If this zone had a map shape saved, redraw it!
        if (cloudZone.geoData) {
          const geoJsonObj = JSON.parse(cloudZone.geoData); 
          const geoLayer = L.geoJSON(geoJsonObj);
          restoredLayer = geoLayer.getLayers()[0];
          
          applyStyle(restoredLayer, cloudZone, false);
          drawnItems.addLayer(restoredLayer);
          attachLayerEvents(restoredLayer, cloudZone);
        }
        
        const validatedPlaylist = (cloudZone.playlist || []).map(t => {
          if (t.type === 'soundcloud') {
            const permalink = extractSoundcloudPermalink(String(t.url || ''));
            if (!permalink) return null;
            return {
              url: permalink,
              permalink,
              label: String(t.label || '').slice(0, 100).replace(/<[^>]*>/g, ''),
              artworkUrl: t.artworkUrl || null,
              trackId: t.trackId || null,
              type: 'soundcloud',
              volume: t.volume ?? 100,
            };
          }
          // Spotify
          const uri = extractSpotifyUri(String(t.url || ''));
          if (!uri || !uri.includes(':track:')) return null;
          return {
            url: String(t.url || ''),
            uri,
            label: String(t.label || '').slice(0, 100).replace(/<[^>]*>/g, ''),
            artworkUrl: safeImageUrl(t.artworkUrl),
            type: 'spotify',
            volume: t.volume ?? 100,
          };
        }).filter(Boolean);

        return {
          ...cloudZone,
          layer: restoredLayer,
          playlist: validatedPlaylist,
          shuffle: cloudZone.shuffle || false,
          groupId: cloudZone.groupId ?? null,
          artChoice: cloudZone.artChoice === 'none' ? 'none' : safeImageUrl(cloudZone.artChoice),
        };
      });

      console.log(zones)
      
      selectedZoneId = zones.length > 0 ? zones[0].id : null;
    }
  } catch (error) {
    console.error("Error loading from cloud:", error);
  }
}

// ── STATE ────────────────────────────────────────────────────────────────────
let zones = [
  { id: 1, name: 'Zone A', color: COLORS[0], playlist: [], shuffle: false, layer: null, groupId: null },
  { id: 2, name: 'Zone B', color: COLORS[1], playlist: [], shuffle: false, layer: null, groupId: null },
];
let nextId = parseInt(localStorage.getItem('zonetune_nextId') || '3');
let groups = [];
let nextGroupId = 1;
let selectedZoneId = zones[0].id;   // ← must come AFTER zones is defined
let mode = 'nav';         // 'draw' (a new zone) | 'edit' (the selected zone's shape) | 'nav'
let drawHandler = null;
let drawVertexCount = 0;
let drawTargetId = null;  // zone whose shape is being drawn in Edit mode; null = a new zone
let drawColor = null;     // color of the shape being drawn
let editSession = null;   // { zone, original } while Edit mode works on a zone; original = shape before editing
let gpsWatchId = null;
let isGpsActive = false;

// ── MAP INIT ─────────────────────────────────────────────────────────────────
const map = L.map('map', {
  center: [37.871994, -122.257884], // Berkeley, CA (lat, lng)
  zoom: 13,
  zoomControl: true,
  // iOS-only long-press-to-right-click. Tapping a shape's first point to finish it leaves this
  // timer running, and it then swallows the next tap anywhere on the page. Nothing here uses it.
  tapHold: false,
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

// Dismiss loader once tiles load
map.once('load', fadeOutLoader);
setTimeout(fadeOutLoader, 2500);

function fadeOutLoader() {
  const el = document.getElementById('mapLoading');
  if (!el) return;
  el.classList.add('gone');
  setTimeout(() => el.remove(), 600);
}

// Feature group holds all drawn layers
const drawnItems = new L.FeatureGroup().addTo(map);

// ── DRAW MANAGEMENT ───────────────────────────────────────────────────────────
// Draw Zone draws a shape for a zone that doesn't exist yet (it's created when the
// shape is finished). Edit Zone reshapes the selected zone by dragging its corners,
// or draws its shape when it has none (or on Redraw), as `target`.
function startDraw(target = null) {
  if (drawHandler) { try { drawHandler.disable(); } catch(e){} drawHandler = null; }
  drawTargetId = target ? target.id : null;
  drawColor = target ? target.color : COLORS[zones.length % COLORS.length];
  // Name the zone in the first hint, so it's clear what the shape is for
  polygonTips.start = `${esc(drawLabel())}: ${basePolygonStart}`;

  drawHandler = new L.Draw.Polygon(map, {
    shapeOptions: {
      color: drawColor,
      fillColor: drawColor,
      fillOpacity: 0.2,
      weight: 2,
      opacity: 0.9,
    },
    showArea: false,
    allowIntersection: false,
    drawError: { color: '#ff5757', timeout: 1000 },
    guidelineDistance: 20,
  });
  drawVertexCount = 0;
  drawHandler.enable();
  placeDrawCursor();
  updateDrawControls();
}

function drawLabel() {
  return drawTargetId != null ? (getZone(drawTargetId)?.name || 'Zone') : 'New zone';
}

const cloneLatLngs = ll => Array.isArray(ll) ? ll.map(cloneLatLngs) : L.latLng(ll.lat, ll.lng);

// Edit mode on the selected zone: drag its corners, or draw it if it has no shape yet
function startEdit() {
  const z = getZone(selectedZoneId);
  if (!z) { showToast('Select a zone to edit first'); setMode('nav'); return; }
  if (editSession?.zone === z && (drawHandler || z.layer?.editing?.enabled())) return; // already on it
  finishShapeTools(); // keeps the changes to the zone edited before
  editSession = { zone: z, original: z.layer ? cloneLatLngs(z.layer.getLatLngs()) : null };
  if (z.layer) {
    z.layer.editing.enable();
    updateDrawControls();
  } else {
    startDraw(z);
  }
}

// Edit mode's Redraw: draw the selected zone's shape from scratch
function redrawEditedZone() {
  const z = editSession?.zone;
  if (!z) return;
  if (z.layer?.editing?.enabled()) z.layer.editing.disable();
  startDraw(z);
}

// Leaves drawing/editing. Shape changes made so far are kept and saved.
function finishShapeTools() {
  if (drawHandler) { try { drawHandler.disable(); } catch(e){} drawHandler = null; }
  drawTargetId = null;
  if (editSession) {
    const { zone: z, original } = editSession;
    editSession = null;
    if (z.layer?.editing?.enabled()) z.layer.editing.disable();
    if (z.layer) applyStyle(z.layer, z, z.id === selectedZoneId);
    const changed = JSON.stringify(z.layer ? z.layer.getLatLngs() : null) !== JSON.stringify(original);
    if (changed && zones.includes(z)) {
      saveZones();
      render();
      checkPersonZone(); // the new shape may now include or exclude the person
    }
  }
  updateDrawControls();
}

// Edit mode's Cancel (or Esc): put the shape back the way it was when editing
// started, even after a Redraw
function cancelEdit() {
  const s = editSession;
  if (s) {
    const z = s.zone;
    if (drawHandler) { try { drawHandler.disable(); } catch(e){} drawHandler = null; }
    if (z.layer?.editing?.enabled()) z.layer.editing.disable();
    if (s.original) {
      z.layer.setLatLngs(cloneLatLngs(s.original));
      // The corner editor keeps its own copy of the points; Leaflet.draw's own undo refreshes it like this
      z.layer.fire('revert-edited', { layer: z.layer });
    } else if (z.layer) {
      drawnItems.removeLayer(z.layer);
      z.layer = null;
    }
    showToast(`${z.name}: changes cancelled`);
  }
  setMode('nav');
}

// A finished shape: a brand-new zone (Draw mode) or the edited zone's new shape (Redraw)
function createDrawnZone(layer, color) {
  const z = { id: nextId++, name: nextDefaultZoneName(), color, playlist: [], shuffle: false, layer, groupId: null };
  zones.push(z);
  drawnItems.addLayer(layer);
  attachLayerEvents(layer, z);
  setMode('nav');
  setSelected(z.id);
  saveZones();
  checkPersonZone();
  showToast(`Created ${z.name}. Rename it and add music in the sidebar`, 4000);
}

function finishRedraw(z, layer) {
  if (z.layer) drawnItems.removeLayer(z.layer);
  z.layer = layer;
  drawnItems.addLayer(layer);
  applyStyle(layer, z, true);
  attachLayerEvents(layer, z);
  render(); // the sidebar's mapped ◉
  if (mode === 'edit' && editSession?.zone === z) {
    layer.editing.enable(); // fine-tune it, then Done (saved then)
    updateDrawControls();
    showToast('Drag the corners to adjust, then press Done');
  } else {
    saveZones();
    checkPersonZone();
  }
}

// Phones and tablets: no mouse to hover with and no keyboard for the Q shortcut
const isTouchScreen = matchMedia('(hover: none) and (pointer: coarse)').matches;

// Leaflet.draw's hints are written for a mouse; reword them for touch screens and mention Q on desktop
const polygonTips = L.drawLocal.draw.handlers.polygon.tooltip;
for (const k of ['start', 'cont', 'end']) {
  if (isTouchScreen) polygonTips[k] = polygonTips[k].replace(/^Click/, 'Tap');
  else if (k !== 'start') polygonTips[k] += '<br>Press Q to start over.';
}
const basePolygonStart = polygonTips.start; // startDraw() puts the zone's name in front

map.on(L.Draw.Event.DRAWVERTEX, e => {
  drawVertexCount = e.layers.getLayers().length;
  updateDrawControls();
});

// Last cursor position over the map, so a restarted draw handler can pick it up
let lastMapMouseMove = null;
map.on('mousemove', e => { if (!e.synthetic) lastMapMouseMove = e; });
map.on('mouseout', () => { lastMapMouseMove = null; });

// While a draw handler is active, Leaflet blocks 'selectstart' on window, which stops
// Ctrl+A / mouse selection inside text fields. Keep the event from reaching window
// when it starts in an input, so zone, group and track fields stay selectable.
document.addEventListener('selectstart', e => {
  if (e.target.closest?.('input, textarea, [contenteditable="true"]')) e.stopPropagation();
});
// Ctrl+A's selectstart isn't targeted at the input, so the block above misses it;
// select the field's text ourselves instead
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || (e.key || '').toLowerCase() !== 'a') return;
  const t = e.target;
  if (!t.matches?.('input:not([type="range"]):not([type="checkbox"]), textarea')) return;
  e.preventDefault();
  t.select();
});

// A fresh draw handler leaves its hint in the map's top-left corner (half under the toolbar) and its
// click-catching marker at the map center until the mouse moves, so the map acts like Navigate mode
// until then. Put both under the cursor, or in the middle of the map when there is no cursor.
function placeDrawCursor() {
  if (!drawHandler) return;
  if (lastMapMouseMove && !isTouchScreen) {
    map.fire('mousemove', lastMapMouseMove);
    return;
  }
  const r = map.getContainer().getBoundingClientRect();
  map.fire('mousemove', {
    synthetic: true,
    originalEvent: { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 },
  });
}

// Throw away the unfinished shape and keep drawing the same zone. The zone keeps its previous
// shape, if it had one. Returns false when no shape is in progress.
function restartDrawing() {
  if (!drawHandler || drawVertexCount === 0) return false;
  startDraw(drawTargetId != null ? getZone(drawTargetId) : null);
  showToast('Drawing cleared — start over');
  return true;
}

// Drawing controls in the map's corner: a "Start over" button while a shape is in progress (the only
// way to restart on a phone) and, on touch screens, the drawing hint. Leaflet.draw's own hint sits
// beside the last point, i.e. under the finger, and runs off the edge of a phone screen.
const DrawPanel = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const panel = L.DomUtil.create('div', 'draw-panel');
    panel.innerHTML = `
      <div class="draw-hint"></div>
      <button type="button" class="tool-btn draw-restart-btn" title="${isTouchScreen ? 'Start over' : 'Start over (Q)'}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
        Start over
      </button>
      <div class="edit-actions">
        <button type="button" class="tool-btn edit-done" data-edit="done" title="Save the new shape">✓ Done</button>
        <button type="button" class="tool-btn" data-edit="redraw" title="Draw the shape from scratch">Redraw</button>
        <button type="button" class="tool-btn" data-edit="cancel" title="${isTouchScreen ? 'Undo the changes' : 'Undo the changes (Esc)'}">Cancel</button>
      </div>`;
    L.DomEvent.disableClickPropagation(panel);
    L.DomEvent.on(panel.querySelector('button'), 'click', e => { L.DomEvent.stop(e); restartDrawing(); });
    L.DomEvent.on(panel.querySelector('.edit-actions'), 'click', e => {
      const action = e.target.closest('button')?.dataset.edit;
      if (!action) return;
      L.DomEvent.stop(e);
      if (action === 'done') setMode('nav');
      else if (action === 'redraw') redrawEditedZone();
      else cancelEdit();
    });
    return panel;
  },
});
const drawPanel = new DrawPanel().addTo(map).getContainer();
const restartBtn = drawPanel.querySelector('.draw-restart-btn');
const drawHint = drawPanel.querySelector('.draw-hint');
const editActions = drawPanel.querySelector('.edit-actions');
const redrawBtn = drawPanel.querySelector('[data-edit="redraw"]');

function updateDrawControls() {
  const drawing = !!drawHandler;
  const reshaping = mode === 'edit' && !!editSession && !drawing; // dragging corners
  restartBtn.classList.toggle('show', drawing && drawVertexCount > 0);
  editActions.classList.toggle('show', mode === 'edit' && !!editSession);
  redrawBtn.classList.toggle('gone', drawing);
  drawHint.classList.toggle('show', reshaping || (drawing && isTouchScreen));
  // Same wording Leaflet.draw would show for this many points
  drawHint.textContent = reshaping
    ? `${editSession.zone.name}: drag a corner to move it, drag a faded middle point to add a corner, ` +
      `${isTouchScreen ? 'tap' : 'click'} a corner to remove it.`
    : drawVertexCount === 0 ? `${drawLabel()}: ${basePolygonStart}`
    : drawVertexCount < 3 ? polygonTips.cont : polygonTips.end;
}

// Esc leaves Draw mode, or cancels Edit mode's changes
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || mode === 'nav') return;
  if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  if (!document.getElementById('libOverlay').classList.contains('hidden')) return; // closes the Spotify picker instead
  if (mode === 'edit') cancelEdit();
  else { setMode('nav'); showToast('Drawing cancelled'); }
});

// Press Q while drawing to discard the in-progress shape and start over
document.addEventListener('keydown', e => {
  if ((e.key || '').toLowerCase() !== 'q' || e.ctrlKey || e.metaKey || e.altKey) return;
  // Typing a "q" into a zone name, group name or track URL must not restart the drawing
  if (e.target.closest?.('input:not([type="range"]), textarea, select, [contenteditable="true"]')) return;
  if (restartDrawing()) e.preventDefault();
});

map.on(L.Draw.Event.CREATED, function(e) {
  const target = drawTargetId != null ? getZone(drawTargetId) : null;
  const color = drawColor;
  drawTargetId = null;
  // Leaflet.draw switches its handler off (DRAWSTOP) right after this event; act once it has
  setTimeout(() => target ? finishRedraw(target, e.layer) : createDrawnZone(e.layer, color), 0);
});

map.on(L.Draw.Event.DRAWSTOP, () => {
  drawHandler = null;
  drawVertexCount = 0;
  updateDrawControls();
});

function applyStyle(layer, z, isSelected) {
  layer.setStyle({
    color:       z.color,
    fillColor:   z.color,
    fillOpacity: isSelected ? 0.22 : 0.12,
    weight:      isSelected ? 2.5 : 1.5,
    opacity:     isSelected ? 1 : 0.7,
    dashArray:   isSelected ? null : '6 4',
  });
}

function attachLayerEvents(layer, z) {
  layer.off('click');
  layer.on('click', function() {
    setSelected(z.id); // in Edit mode this switches editing to the clicked zone
    if (mode === 'nav') openZonePopup(layer, z);
  });
  layer.on('mouseover', function() {
    if (z.id !== selectedZoneId) {
      layer.setStyle({ fillOpacity: 0.2, weight: 2 });
    }
  });
  layer.on('mouseout', function() {
    applyStyle(layer, z, z.id === selectedZoneId);
  });
}

function openZonePopup(layer, z) {
  const track = zoneCurrentTrack(z);
  const musicHtml = track
    ? `<div class="popup-music">
         <span class="popup-music-label">Current track:</span>
         <span class="popup-track">${esc(track.label || 'Untitled')}</span>
       </div>`
    : `<div class="popup-no-music">No music selected</div>`;

  layer.bindPopup(`
    <div>
      <div class="popup-name" style="color:${z.color}">${esc(z.name)}</div>
      ${musicHtml}
      <div class="popup-actions">
        <button class="popup-btn del" onclick="deleteZone(${z.id})">Delete zone</button>
      </div>
    </div>
  `, { maxWidth: 220, closeButton: true }).openPopup();
}

// ── ZONE ALBUM ART ────────────────────────────────────────────────────────────
// Each drawn zone with a song that has album art shows that art in the middle of its shape.
// z.artChoice: null = the first song's art, 'none' = no art, otherwise the chosen art's URL
// (falls back to the first song's art once no song in the zone uses it any more).

// The zone's distinct album art, each with the songs that use it
function zoneArtOptions(z) {
  const options = [];
  (z.playlist || []).forEach(t => {
    const url = safeImageUrl(t.artworkUrl);
    if (!url) return;
    const o = options.find(o => o.url === url);
    if (o) o.labels.push(t.label);
    else options.push({ url, labels: [t.label] });
  });
  return options;
}

function zoneArtUrl(z) {
  if (z.artChoice === 'none') return null;
  const urls = zoneArtOptions(z).map(o => o.url);
  return urls.includes(z.artChoice) ? z.artChoice : (urls[0] || null);
}

// Scales with the zone on screen (up to 72px) so it never spills out of a small zone
function zoneArtSize(layer) {
  const b = layer.getBounds();
  const nw = map.latLngToContainerPoint(b.getNorthWest());
  const se = map.latLngToContainerPoint(b.getSouthEast());
  return Math.min(72, Math.round(Math.min(se.x - nw.x, se.y - nw.y) * 0.45));
}

const artMarkers = new Map();   // zone id → marker showing that zone's art

// Bring the art on the map in line with the zones; cheap enough to run after every render
function syncZoneArt() {
  for (const [id, marker] of artMarkers) {
    if (!getZone(id)) { map.removeLayer(marker); artMarkers.delete(id); }
  }
  zones.forEach(z => {
    const url = z.layer ? zoneArtUrl(z) : null;
    const size = url ? zoneArtSize(z.layer) : 0;
    let marker = artMarkers.get(z.id);
    if (size < 20) {   // no art, or the zone is too small on screen to fit it
      if (marker) { map.removeLayer(marker); artMarkers.delete(z.id); }
      return;
    }
    const center = z.layer.getCenter();
    if (!marker) {
      // Not interactive: clicks and taps go through to the zone and to drawing
      marker = L.marker(center, { interactive: false, keyboard: false, zIndexOffset: -1000 }).addTo(map);
      artMarkers.set(z.id, marker);
    } else {
      marker.setLatLng(center);
    }
    const key = `${url} ${size} ${z.color}`;
    if (marker.artKey !== key) {
      marker.artKey = key;
      marker.setIcon(L.divIcon({
        className: 'zone-art',
        iconSize: [size, size],
        html: `<img src="${esc(url)}" alt="" style="border-color:${z.color}" onerror="this.style.display='none'">`,
      }));
    }
  });
}
map.on('zoomend', syncZoneArt);

// Spotify songs saved before album art was stored have none, and ones added before Spotify was
// connected have a bare URI for a name; look them up once and save what's found
async function backfillSpotifyDetails() {
  const incomplete = zones.flatMap(z => z.playlist || [])
    .filter(t => t.type === 'spotify' && (!t.artworkUrl || t.label === t.uri));
  if (!incomplete.length) return;
  let changed = false;
  await Promise.all(incomplete.map(async t => {
    const { title, artworkUrl } = await fetchSpotifyOembed(t.uri);
    if (!t.artworkUrl && artworkUrl) { t.artworkUrl = artworkUrl; changed = true; }
    if (t.label === t.uri && title) { t.label = title; changed = true; }
  }));
  if (changed) {
    saveZones();
    render();
  }
}

// ── MODE ─────────────────────────────────────────────────────────────────────
function setMode(m) {
  finishShapeTools(); // a half-drawn new zone is dropped; shape edits are kept
  mode = m;
  document.getElementById('btnDraw').classList.toggle('on', m === 'draw');
  document.getElementById('btnEdit').classList.toggle('on', m === 'edit');
  document.getElementById('btnNav').classList.toggle('on', m === 'nav');
  if (m === 'draw') startDraw();
  else if (m === 'edit') startEdit();
  updateDrawControls();
}

// ── SELECTION ────────────────────────────────────────────────────────────────
function setSelected(id) {
  selectedZoneId = id;
  zones.forEach(z => {
    if (z.layer) applyStyle(z.layer, z, z.id === id);
  });
  render();
  updateChip();
  if (mode === 'edit') startEdit(); // edit whichever zone is selected
}

function updateChip() {
  const chip = document.getElementById('chipWrap');
  const z = getZone(selectedZoneId);
  if (z) {
    chip.classList.remove('hidden');
    document.getElementById('chipName').textContent = z.name;
    document.getElementById('chipDot').style.background = z.color;
  } else {
    chip.classList.add('hidden');
  }
}

// ── CRUD ─────────────────────────────────────────────────────────────────────
function nextDefaultZoneName() {
  const taken = new Set(zones.map(z => z.name));
  let n = 1;
  while (taken.has(`Zone ${n}`)) n++;
  return `Zone ${n}`;
}

function addZoneFromInput() {
  const inp = document.getElementById('newZoneName');
  const name = sanitizeName(inp.value.trim()) || nextDefaultZoneName();
  const color = COLORS[zones.length % COLORS.length];
  const z = { id: nextId++, name, color, playlist: [], shuffle: false, layer: null, groupId: null };
  zones.push(z);
  inp.value = '';

  setSelected(z.id); // in Edit mode this goes straight to drawing its shape

  saveZones();
  render();
  if (mode !== 'edit') showToast(`Added ${name}. Press Edit Zone to draw its area`, 4000);
}

function addGroup() {
  const inp = document.getElementById('newGroupName');
  const raw = inp.value.trim();
  const name = sanitizeName(raw) || `Group ${nextGroupId}`;
  const exists = groups.some(g => g.name.toLowerCase() === name.toLowerCase());
  if (exists) {
    showToast('Group already exists.');
    return;
  }
  groups.push({ id: nextGroupId++, name });
  inp.value = '';
  saveZones();
  render();
}


// Group renaming works like zone renaming: Edit turns the name into a text box, and Enter (key or
// button) finishes it. Groups being edited, with the text typed so far (kept across re-renders):
const groupNameDrafts = new Map();

function groupNameInput(id) {
  return document.querySelector(`.group-header[data-group-id="${id}"] .group-name-inp`);
}

function startGroupEdit(id) {
  const g = groups.find(g => g.id === id);
  if (!g) return;
  groupNameDrafts.set(id, g.name);
  render();
  const inp = groupNameInput(id);
  if (inp) { inp.focus(); inp.select(); }
}

// An empty name keeps the old one. A name another group already has is refused, and the
// box stays open so it can be changed (Escape gives up instead).
function finishGroupEdit(id) {
  const g = groups.find(g => g.id === id);
  if (!g || !groupNameDrafts.has(id)) return;
  const name = sanitizeName(groupNameDrafts.get(id).trim());
  if (name && groups.some(o => o.id !== id && o.name.toLowerCase() === name.toLowerCase())) {
    showToast('Group already exists.');
    groupNameInput(id)?.focus();
    return;
  }
  if (name && name !== g.name) {
    g.name = name;
    saveZones();
  }
  groupNameDrafts.delete(id);
  render();
}

function cancelGroupEdit(id) {
  groupNameDrafts.delete(id);
  render();
}

function deleteGroup(id) {
  groupNameDrafts.delete(id);
  zones.forEach(z => { if (z.groupId === id) z.groupId = null; });
  groups = groups.filter(g => g.id !== id);
  saveZones();
  render();
}

function moveZoneToGroup(zoneId, groupId) {
  const z = getZone(zoneId);
  if (!z) return;
  z.groupId = groupId;
  saveZones();
  render();
}

function deleteZone(id) {
  map.closePopup();
  if (editSession?.zone.id === id || drawTargetId === id) setMode('nav');
  const z = getZone(id);
  if (z && z.layer) drawnItems.removeLayer(z.layer);
  zones = zones.filter(z => z.id !== id);
  saveZones();
  if (selectedZoneId === id) selectedZoneId = zones[0]?.id ?? null;
  render();
  updateChip();
  checkPersonZone(); // the person may have been standing in the deleted zone
}

function detectTrackType(url) {
  if (/^spotify:|open\.spotify\.com/.test(url)) return 'spotify';
  if (parseSoundcloudLink(url)) return 'soundcloud';
  return null;
}
function extractSoundcloudPermalink(url) {
  // Normalize to just https://soundcloud.com/artist/track (no query, m./www. host)
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    if (SC_HOSTS.includes(u.hostname) && path) return 'https://soundcloud.com' + path;
  } catch (e) { }
  return null;
}

// ── SOUNDCLOUD LINKS ──────────────────────────────────────────────────────────
// Any SoundCloud link can be pasted: a song, a playlist/album, a profile (their
// uploads) or a likes page, from soundcloud.com, m./www. or an on.soundcloud.com
// share link. There's no API key, so oEmbed says what the link is and a hidden
// embed widget (the same player that plays the songs) lists what's in it.
const SC_HOSTS = ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'];
const SC_LINK_HELP = 'Paste a SoundCloud song, playlist, album, profile or likes link';
// Site pages (soundcloud.com/<page>) that aren't anyone's profile
const SC_SITE_PAGES = ['discover', 'search', 'stream', 'feed', 'charts', 'upload', 'settings', 'messages', 'notifications', 'tags'];
// Profile tabs the embed widget can't show, and what to paste instead
const SC_PROFILE_TABS = {
  sets: 'Open one of their playlists and paste its link',
  albums: 'Open one of their albums and paste its link',
  'popular-tracks': 'Paste their profile link to add their uploads',
  reposts: "SoundCloud doesn't let other sites list reposts",
  followers: SC_LINK_HELP,
  following: SC_LINK_HELP,
  comments: SC_LINK_HELP,
};

// Returns null for non-SoundCloud links, { error } for SoundCloud pages that
// can't be added, otherwise { kind: 'likes' | 'link', url } with url normalized
function parseSoundcloudLink(raw) {
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw); } catch (e) { return null; }
  if (u.hostname === 'on.soundcloud.com') return { kind: 'link', url: 'https://on.soundcloud.com' + u.pathname };
  if (!SC_HOSTS.includes(u.hostname)) return null;

  const [user, tab, ...rest] = u.pathname.split('/').filter(Boolean);
  if (!user || SC_SITE_PAGES.includes(user)) return { error: SC_LINK_HELP };
  if (user === 'you') {
    return { error: 'Your SoundCloud Library is only visible to you. Paste your profile’s likes link (soundcloud.com/your-name/likes) or a playlist link instead' };
  }
  const profile = 'https://soundcloud.com/' + user;
  if (!rest.length && tab === 'likes') return { kind: 'likes', url: profile };
  if (!rest.length && tab === 'tracks') return { kind: 'link', url: profile };
  if (!rest.length && SC_PROFILE_TABS[tab]) return { error: SC_PROFILE_TABS[tab] };
  // A profile, song or playlist (secret links keep their /s-xxxx part)
  return { kind: 'link', url: [profile, tab, ...rest].filter(Boolean).join('/') };
}

// What the link points at, as the API URL the embed widget loads,
// e.g. https://api.soundcloud.com/playlists/18
async function soundcloudOembed(url) {
  let res;
  try {
    res = await fetch(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`);
  } catch (e) {
    throw new Error("Couldn't reach SoundCloud. Check your connection and try again");
  }
  if (res.status === 403 || res.status === 404) throw new Error("SoundCloud couldn't find that link. It may be private or deleted");
  if (!res.ok) throw new Error(`SoundCloud error (${res.status})`);
  const data = await res.json();
  const src = (data.html || '').match(/[?&;]url=([^&"]+)/);
  const apiUrl = src ? decodeURIComponent(src[1]) : '';
  const m = apiUrl.match(/^https:\/\/api\.soundcloud\.com\/(tracks|playlists|users)\/(\d+)/);
  if (!m) throw new Error("That SoundCloud link can't be played on other sites");
  return { apiUrl, kind: m[1], id: m[2], title: data.title || 'SoundCloud' };
}

// Loads a URL into a throwaway hidden widget and collects up to `limit` songs.
// Song details arrive in batches, and profiles/likes (`paged`) a page at a time,
// so poll until enough have arrived or the list stops changing.
function loadSoundcloudSounds(url, limit, paged) {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.src = 'https://w.soundcloud.com/player/?auto_play=false&url=' + encodeURIComponent(url);
    iframe.title = 'SoundCloud link reader';
    iframe.tabIndex = -1;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;width:1px;height:1px;bottom:0;left:0;opacity:0;pointer-events:none;';
    document.body.appendChild(iframe);

    const isFull = s => s && s.title && s.permalink_url;
    let latest = [], poll = null, done = false;
    const finish = (err, sounds) => {
      if (done) return;
      done = true;
      clearTimeout(giveUp);
      clearInterval(poll);
      iframe.remove();
      if (err) reject(err); else resolve(sounds);
    };
    // Keep whatever arrived if a huge list is still loading
    const giveUp = setTimeout(() => latest.length
      ? finish(null, latest)
      : finish(new Error('SoundCloud took too long to respond. Try again')), 30000);

    const widget = SC.Widget(iframe);
    widget.bind(SC.Widget.Events.READY, () => {
      let lastSig = '', lastChange = Date.now();
      poll = setInterval(() => widget.getSounds(all => {
        all = all || [];
        const head = all.slice(0, limit);
        latest = head.filter(isFull);
        const sig = all.length + ':' + all.filter(isFull).length;
        if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }
        const headDone = latest.length === head.length && (!paged || all.length >= limit);
        if (headDone || Date.now() - lastChange > 3000) finish(null, latest);
      }), 500);
    });
  });
}

// Zone playlist entry for a widget sound, or null if SoundCloud won't stream it
function soundcloudTrackFromSound(s) {
  if (s.kind !== 'track' || s.streamable === false || s.playable === false || s.policy === 'BLOCK') return null;
  let permalink = extractSoundcloudPermalink(s.permalink_url || '');
  if (!permalink) return null;
  // Private songs only play through their secret share link
  if (s.secret_token && !permalink.endsWith('/' + s.secret_token)) permalink += '/' + s.secret_token;
  const name = s.user?.username ? `${s.title} — ${s.user.username}` : s.title;
  return {
    url: permalink,
    permalink,
    label: String(name).slice(0, 100).replace(/<[^>]*>/g, ''),
    artworkUrl: s.artwork_url || s.user?.avatar_url || null,
    trackId: s.id ?? null,
    type: 'soundcloud',
    volume: 100,
  };
}

// Resolves any pasted SoundCloud link to the songs it contains
async function resolveSoundcloudLink(raw) {
  const link = parseSoundcloudLink(raw);
  if (!link || link.error) throw new Error(link?.error || SC_LINK_HELP);
  const info = await soundcloudOembed(link.url);
  // A likes page embeds as the profile itself, so ask for the likes list instead
  const likes = link.kind === 'likes' && info.kind === 'users';
  const src = likes ? `https://api.soundcloud.com/users/${info.id}/favorites` : info.apiUrl;
  const sounds = await loadSoundcloudSounds(src, MAX_ZONE_TRACKS, info.kind === 'users');
  return {
    kind: info.kind,
    title: likes ? `${info.title}’s likes` : info.title,
    tracks: sounds.map(soundcloudTrackFromSound).filter(Boolean),
  };
}

// Track title and album art from Spotify's public oEmbed endpoint. It needs no Spotify login,
// so both also work for songs added before Spotify was connected.
async function fetchSpotifyOembed(uri) {
  try {
    const trackUrl = `https://open.spotify.com/track/${uri.split(':').pop()}`;
    const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`);
    if (!res.ok) return {};
    const data = await res.json();
    return {
      title: typeof data.title === 'string' ? data.title.slice(0, 100).replace(/<[^>]*>/g, '') : null,
      artworkUrl: safeImageUrl(data.thumbnail_url),
    };
  } catch (e) {
    return {};
  }
}

// Image URLs come from third-party responses and saved data, and end up in src attributes
function safeImageUrl(url) {
  return typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null;
}

function sanitizeName(val) {
  return val.replace(/<[^>]*>/g, '').slice(0, 40);
}

function renameZone(id, val) {
  const z = getZone(id);
  if (!z) return;
  z.name = val || 'Unnamed';
  saveZones();
  updateChip();
  // Update the Music section label in place; a full render() would steal focus from the input
  const musicLabel = document.querySelector(`.music-zone-name[data-zone="${id}"]`);
  if (musicLabel) musicLabel.textContent = z.name;
  if (z.layer) attachLayerEvents(z.layer, z);
}

function sanitizeSpotifyUrl(url) {
  const trimmed = url.trim();
  // Only allow spotify: URIs or https://open.spotify.com URLs
  if (/^spotify:[a-z]+:[a-zA-Z0-9]+$/.test(trimmed)) return trimmed;
  if (/^https:\/\/open\.spotify\.com\/[a-z]+\/[a-zA-Z0-9]+/.test(trimmed)) return trimmed;
  return '';
}

async function addTrack(zoneId, url) {
  const z = getZone(zoneId);
  if (!z || !url.trim()) return;
  if (z.playlist.length >= MAX_ZONE_TRACKS) { showToast(`Max ${MAX_ZONE_TRACKS} tracks per zone`); return; }

  const type = detectTrackType(url.trim());
  if (!type) { showToast('Paste a Spotify track URL or a SoundCloud link'); return; }

  if (type === 'spotify') {
    const uri = extractSpotifyUri(url.trim());
    if (!uri || !uri.includes(':track:')) { showToast('Please paste a Spotify track URL'); return; }
    const [apiLabel, oembed] = await Promise.all([fetchTrackLabel(url.trim(), uri), fetchSpotifyOembed(uri)]);
    // Without Spotify connected the API label is just the URI; the oEmbed title beats that
    const label = apiLabel === uri && oembed.title ? oembed.title : apiLabel;
    z.playlist.push({ url: url.trim(), uri, label, artworkUrl: oembed.artworkUrl || null, type: 'spotify', volume: 100 });

  } else if (type === 'soundcloud') {
    showToast('Loading from SoundCloud…', 30000);
    let found;
    try {
      found = await resolveSoundcloudLink(url.trim());
    } catch (e) {
      showToast(e.message, 6000);
      return;
    }
    if (!found.tracks.length) { showToast(`No playable songs in ${found.title}`, 4000); return; }

    const have = new Set(z.playlist.map(t => t.permalink));
    const fresh = found.tracks.filter(t => {
      if (have.has(t.permalink)) return false;
      have.add(t.permalink); // a playlist can list the same song twice
      return true;
    });
    const room = MAX_ZONE_TRACKS - z.playlist.length;
    const added = fresh.slice(0, room);
    if (!added.length) {
      showToast(room ? `Already in ${z.name}` : `Max ${MAX_ZONE_TRACKS} tracks per zone`);
      return;
    }
    z.playlist.push(...added);
    showToast(found.kind === 'tracks'
      ? `Added to ${z.name}: ${added[0].label}`
      : `Added ${added.length} song${added.length !== 1 ? 's' : ''} from ${found.title} to ${z.name}` +
        (z.playlist.length >= MAX_ZONE_TRACKS ? ` (zone is now full: max ${MAX_ZONE_TRACKS})` : ''), 4000);
  }

  refreshQueue(z);
  saveZones();
  render();
}

function removeTrack(zoneId, index) {
  const z = getZone(zoneId);
  if (!z) return;
  z.playlist.splice(index, 1);
  refreshQueue(z);
  saveZones();
  render();
}

async function fetchTrackLabel(url, uri) {
  if (!spotifyToken) return uri; // fallback to raw URI
  try {
    await ensureToken();
    const trackId = uri.split(':').pop();
    const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
      headers: { 'Authorization': 'Bearer ' + spotifyToken }
    });
    if (!res.ok) {
      // Same account/app problem will also block playback, so say so now
      showToast('Spotify API error: ' + await spotifyErrorText(res), 6000);
      return uri;
    }
    const data = await res.json();
    return `${data.name} — ${data.artists?.map(a => a.name).join(', ')}`;
  } catch (e) {
    return uri;
  }
}

function clearAllZones() {
  if (!confirm('Remove all zone shapes from the map?')) return;
  const wasMode = mode;
  setMode('nav'); // finish any drawing/editing before the shapes go
  zones.forEach(z => { if (z.layer) { drawnItems.removeLayer(z.layer); z.layer = null; } });
  saveZones();
  render();
  checkPersonZone(); // with no shapes left, the person is outside every zone
  if (wasMode !== 'nav') setMode(wasMode);
}

// Touch drag state (for mobile - press & hold 1s to enter drag mode)
let touchDragState = null;
let touchDragJustEnded = false;
const HOLD_DURATION_MS = 1000;

// Zones whose name is being edited; every other zone shows its name as text and can be dragged
const editingZoneIds = new Set();

function startZoneEdit(id) {
  editingZoneIds.add(id);
  render();
  const inp = document.querySelector(`.zone-row[data-zone-id="${id}"] .zone-name-inp`);
  if (inp) { inp.focus(); inp.select(); }
}

function finishZoneEdit(id, val) {
  renameZone(id, sanitizeName(val.trim()));
  editingZoneIds.delete(id);
  render();
}

// ── ZONE "EDIT" MENU ──────────────────────────────────────────────────────────
// A popover on <body> (so the sidebar's scrolling can't clip it) with "Rename" and
// "Change album art", which swaps the menu for a list of the zone's album art.
let zoneMenu = null;   // { el, zoneId, anchor } while open

function toggleZoneMenu(zoneId, anchor) {
  const wasOpen = zoneMenu?.zoneId === zoneId;
  closeZoneMenu();
  if (wasOpen) return;
  const el = document.createElement('div');
  el.className = 'zone-menu';
  el.setAttribute('role', 'menu');
  document.body.appendChild(el);
  zoneMenu = { el, zoneId, anchor };
  anchor.setAttribute('aria-expanded', 'true');
  el.innerHTML = `
    <button class="zone-menu-item" role="menuitem" data-act="rename">Rename</button>
    <button class="zone-menu-item" role="menuitem" data-act="art">Change album art</button>`;
  el.querySelector('[data-act="rename"]').addEventListener('click', () => {
    closeZoneMenu();
    startZoneEdit(zoneId);
  });
  el.querySelector('[data-act="art"]').addEventListener('click', showArtPicker);
  positionZoneMenu();
  el.querySelector('button').focus();
}

function closeZoneMenu() {
  if (!zoneMenu) return;
  zoneMenu.el.remove();
  zoneMenu.anchor.setAttribute('aria-expanded', 'false');
  zoneMenu = null;
}

function showArtPicker() {
  const z = getZone(zoneMenu.zoneId);
  if (!z) return closeZoneMenu();
  const options = zoneArtOptions(z);
  const current = zoneArtUrl(z) || 'none';
  const option = (value, thumb, label) => `
    <button class="zone-menu-item art-option${value === current ? ' current' : ''}" role="menuitemradio"
            aria-checked="${value === current}" data-art="${esc(value)}">
      ${thumb}<span class="art-option-label">${esc(label)}</span>
    </button>`;
  zoneMenu.el.innerHTML = `
    <div class="zone-menu-title">Album art for ${esc(z.name)}</div>
    ${options.map(o => option(o.url, `<img class="art-thumb" src="${esc(o.url)}" alt="">`, o.labels.join(', '))).join('')}
    ${option('none', '<span class="art-thumb no-art"></span>', 'No Album Art')}
    ${options.length ? '' : '<div class="zone-menu-note">Add a song to this zone to choose its album art.</div>'}
    ${z.layer ? '' : '<div class="zone-menu-note">Draw this zone on the map to see its art there.</div>'}`;
  zoneMenu.el.querySelectorAll('.art-option').forEach(btn => btn.addEventListener('click', () => {
    z.artChoice = btn.dataset.art;
    saveZones();
    syncZoneArt();
    const anchor = zoneMenu.anchor;
    closeZoneMenu();
    anchor.focus();
  }));
  positionZoneMenu();
  (zoneMenu.el.querySelector('.art-option.current') || zoneMenu.el.querySelector('button')).focus();
}

// Below the Edit button, or above it when there's no room below; always fully on screen
function positionZoneMenu() {
  const { el, anchor } = zoneMenu;
  const a = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  const left = Math.max(8, Math.min(a.right - w, innerWidth - w - 8));
  let top = a.bottom + 4;
  if (top + h > innerHeight - 8) top = Math.max(8, a.top - h - 4);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

// Close on a tap/click elsewhere, Escape, or anything that would leave it floating away from its button
document.addEventListener('pointerdown', e => {
  if (zoneMenu && !zoneMenu.el.contains(e.target) && !zoneMenu.anchor.contains(e.target)) closeZoneMenu();
}, true);
document.addEventListener('keydown', e => {
  if (zoneMenu && e.key === 'Escape') {
    const anchor = zoneMenu.anchor;
    closeZoneMenu();
    anchor.focus();
  }
});
document.addEventListener('scroll', e => {
  if (zoneMenu && !zoneMenu.el.contains(e.target)) closeZoneMenu();
}, true);
window.addEventListener('resize', () => closeZoneMenu());

function appendZoneRow(parent, z) {
  const editing = editingZoneIds.has(z.id);
  const div = document.createElement('div');
  div.className = 'zone-row' + (z.id === selectedZoneId ? ' selected' : '') + (editing ? ' editing' : ' draggable');
  div.dataset.zoneId = z.id;
  div.draggable = !editing;
  div.innerHTML = `
    <div class="zone-pip" style="background:${z.color}"></div>
    ${editing
      ? `<input class="zone-name-inp" value="${esc(z.name)}" maxlength="40" placeholder="Zone name">
         <button class="zone-name-btn enter" title="Save name">Enter</button>`
      : `<span class="zone-name" title="Double-click to zoom to this zone · drag onto a group to move">${esc(z.name)}</span>
         <button class="zone-name-btn" title="Edit zone" aria-haspopup="menu" aria-expanded="false">
           Edit<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"/></svg>
         </button>`}
    <span class="zone-mapped" title="${z.layer ? 'Mapped' : 'Not drawn yet'}">${z.layer ? '◉' : '○'}</span>
    <button class="del-btn" title="Delete zone">✕</button>
  `;
  const nameInp = div.querySelector('.zone-name-inp');
  div.querySelector('.zone-name-btn').addEventListener('click', e => {
    e.stopPropagation();
    if (editing) finishZoneEdit(z.id, nameInp.value);
    else toggleZoneMenu(z.id, e.currentTarget);
  });
  if (editing) {
    nameInp.addEventListener('input', e => renameZone(z.id, e.target.value));
    nameInp.addEventListener('keydown', e => { if (e.key === 'Enter') finishZoneEdit(z.id, nameInp.value); });
  }
  div.querySelector('.del-btn').addEventListener('click', e => { e.stopPropagation(); deleteZone(z.id); });

  function handleSelect(e) {
    if (e.target.closest('button, .zone-name-inp')) return;
    if (touchDragState || touchDragJustEnded) return;
    setSelected(z.id);
  }
  div.addEventListener('click', handleSelect);
  div.addEventListener('touchend', handleSelect, { passive: true });

  // Mouse drag (desktop): grab anywhere on a row whose name is finalized
  if (!editing) {
    div.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', z.id);
      e.dataTransfer.effectAllowed = 'move';
      div.classList.add('zone-dragging');
    });
    div.addEventListener('dragend', () => div.classList.remove('zone-dragging'));
  }

  // Touch drag (mobile): hold 1s anywhere on a finalized row (except its buttons) to enter drag mode
  function touchStart(e) {
    if (editing || e.touches.length !== 1) return;
    if (e.target.closest('button')) return;
    const t = e.touches[0];
    touchDragState = {
      zoneId: z.id,
      originalGroupId: z.groupId,
      startX: t.clientX,
      startY: t.clientY,
      dragMode: false,
      lastTarget: null,
      holdTimer: setTimeout(() => {
        if (!touchDragState || touchDragState.zoneId !== z.id) return;
        touchDragState.dragMode = true;
        touchDragState.holdTimer = null;
        div.classList.add('zone-dragging');
        if (navigator.vibrate) navigator.vibrate(50);
        showToast('Drag to move');
      }, HOLD_DURATION_MS)
    };
  }
  function touchMove(e) {
    if (!touchDragState || touchDragState.zoneId !== z.id) return;
    const t = e.touches[0];
    const dx = Math.abs(t.clientX - touchDragState.startX);
    const dy = Math.abs(t.clientY - touchDragState.startY);
    if (!touchDragState.dragMode) {
      if (dx > 15 || dy > 15) {
        if (touchDragState.holdTimer) {
          clearTimeout(touchDragState.holdTimer);
          touchDragState.holdTimer = null;
        }
        touchDragState = null;
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const header = el?.closest('.group-header.drop-target');
    document.querySelectorAll('.group-header.drop-target').forEach(h => h.classList.remove('drop-target-active'));
    if (header) {
      header.classList.add('drop-target-active');
      touchDragState.lastTarget = header;
    }
  }
  function touchEnd(e) {
    if (!touchDragState || touchDragState.zoneId !== z.id) return;
    if (touchDragState.holdTimer) {
      clearTimeout(touchDragState.holdTimer);
      touchDragState.holdTimer = null;
    }
    if (touchDragState.dragMode) {
      e.preventDefault();
      e.stopPropagation();
      touchDragJustEnded = true;
      setTimeout(() => { touchDragJustEnded = false; }, 150);
      const header = touchDragState.lastTarget;
      document.querySelectorAll('.group-header.drop-target').forEach(h => h.classList.remove('drop-target-active'));
      if (header) {
        const gid = header.dataset.groupId;
        const dropGroupId = gid === 'null' ? null : +gid;
        if (String(dropGroupId) !== String(touchDragState.originalGroupId)) {
          moveZoneToGroup(z.id, dropGroupId);
        }
      }
    }
    div.classList.remove('zone-dragging');
    touchDragState = null;
  }
  function touchCancel() {
    if (touchDragState?.zoneId === z.id) {
      if (touchDragState.holdTimer) clearTimeout(touchDragState.holdTimer);
      div.classList.remove('zone-dragging');
      document.querySelectorAll('.group-header.drop-target').forEach(h => h.classList.remove('drop-target-active'));
      touchDragState = null;
    }
  }
  div.addEventListener('touchstart', touchStart, { passive: true });
  div.addEventListener('touchmove', touchMove, { passive: false });
  div.addEventListener('touchend', touchEnd, { passive: false });
  div.addEventListener('touchcancel', touchCancel, { passive: true });

  parent.appendChild(div);
}

function setupDropTarget(headerEl, groupId) {
  headerEl.dataset.groupId = String(groupId);
  headerEl.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    headerEl.classList.add('drop-target-active');
  });
  headerEl.addEventListener('dragleave', () => headerEl.classList.remove('drop-target-active'));
  headerEl.addEventListener('drop', e => {
    e.preventDefault();
    headerEl.classList.remove('drop-target-active');
    const zoneId = +e.dataTransfer.getData('text/plain');
    if (zoneId) moveZoneToGroup(zoneId, groupId);
  });
}

// ── RENDER SIDEBAR ────────────────────────────────────────────────────────────
function render() {
  closeZoneMenu();   // its Edit button is about to be replaced
  const gl = document.getElementById('groupsList');
  gl.innerHTML = '';

  // Ungrouped section
  const ugSection = document.createElement('div');
  ugSection.className = 'group-section';
  ugSection.innerHTML = `
    <div class="group-header drop-target" data-group-id="null"><span class="group-name">Ungrouped</span></div>
    <div class="group-zones"></div>
  `;
  const ugZones = zones.filter(z => z.groupId == null);
  ugZones.forEach(z => appendZoneRow(ugSection.querySelector('.group-zones'), z));
  setupDropTarget(ugSection.querySelector('.group-header'), null);
  gl.appendChild(ugSection);

  // Group sections
  groups.forEach(g => {
    const editing = groupNameDrafts.has(g.id);
    const section = document.createElement('div');
    section.className = 'group-section';
    section.innerHTML = `
      <div class="group-header drop-target" data-group-id="${g.id}">
        ${editing
          ? `<input class="group-name-inp" value="${esc(groupNameDrafts.get(g.id))}" maxlength="40" placeholder="Group name">
             <button class="zone-name-btn group-name-btn enter" title="Save name">Enter</button>`
          : `<span class="group-name" title="${esc(g.name)}">${esc(g.name)}</span>
             <button class="zone-name-btn group-name-btn" title="Rename group">Edit</button>`}
        <button class="group-del-btn" title="Delete group">✕</button>
      </div>
      <div class="group-zones"></div>
    `;
    section.querySelector('.group-del-btn').addEventListener('click', e => { e.stopPropagation(); deleteGroup(g.id); });
    section.querySelector('.group-name-btn').addEventListener('click', e => {
      e.stopPropagation();
      if (editing) finishGroupEdit(g.id);
      else startGroupEdit(g.id);
    });
    if (editing) {
      const nameInp = section.querySelector('.group-name-inp');
      nameInp.addEventListener('input', () => groupNameDrafts.set(g.id, nameInp.value));
      nameInp.addEventListener('keydown', e => {
        if (e.key === 'Enter') finishGroupEdit(g.id);
        if (e.key === 'Escape') cancelGroupEdit(g.id);
      });
    }
    const gZones = zones.filter(z => z.groupId === g.id);
    gZones.forEach(z => appendZoneRow(section.querySelector('.group-zones'), z));
    setupDropTarget(section.querySelector('.group-header'), g.id);
    gl.appendChild(section);
  });

  // Music list

  // Music list
  const ml = document.getElementById('musicList');
  ml.innerHTML = '';
  zones.forEach(z => {
    const div = document.createElement('div');
    div.className = 'music-item';

    const tracksHtml = (z.playlist || []).map((t, i) => `
    <div class="track-row">
    ${t.type === 'soundcloud'
        ? `<svg class="track-icon" viewBox="0 0 24 24" fill="${z.color}" width="12" height="12">
           <path d="M1.175 12.225c-.017 0-.032.001-.047.003a.204.204 0 00-.173.199l-.232 2.552.232 2.545c.01.107.098.188.22.188.016 0 .031-.001.046-.003.102-.014.176-.1.184-.204l.263-2.526-.263-2.559a.203.203 0 00-.23-.195zm1.658-.386c-.02 0-.04.002-.06.005a.27.27 0 00-.226.263l-.2 2.675.2 2.662c.012.141.127.249.272.249.018 0 .037-.002.055-.005.138-.024.237-.143.243-.284l.226-2.622-.226-2.683a.274.274 0 00-.284-.26zm1.686-.4c-.024 0-.05.003-.073.008a.337.337 0 00-.276.328l-.173 2.467.173 2.457a.34.34 0 00.34.322.34.34 0 00.34-.322l.196-2.457-.196-2.467a.34.34 0 00-.331-.336zm1.7.205a.408.408 0 00-.407.397l-.148 2.27.148 2.254a.408.408 0 00.815 0l.168-2.254-.168-2.27a.408.408 0 00-.408-.397zm1.733-.437a.476.476 0 00-.475.464l-.124 2.104.124 2.088a.476.476 0 00.95 0l.14-2.088-.14-2.104a.476.476 0 00-.475-.464zm1.742-.195a.544.544 0 00-.543.532l-.1 1.922.1 1.906a.544.544 0 001.086 0l.114-1.906-.114-1.922a.544.544 0 00-.543-.532zm1.75-.269a.613.613 0 00-.611.6l-.077 1.726.077 1.71a.612.612 0 001.223 0l.087-1.71-.087-1.726a.612.612 0 00-.612-.6zm1.76-.134a.68.68 0 00-.679.668l-.054 1.537.054 1.522a.68.68 0 001.358 0l.061-1.522-.061-1.537a.68.68 0 00-.68-.668zm1.77-.067a.748.748 0 00-.747.736l-.031 1.336.031 1.322a.748.748 0 001.495 0l.035-1.322-.035-1.336a.748.748 0 00-.748-.736zm2.555.7c-.183-.047-.373-.072-.568-.072-1.2 0-2.162.974-2.162 2.174v4.342c0 .228.184.412.412.412h5.51a1.65 1.65 0 001.648-1.648 1.65 1.65 0 00-1.648-1.648c-.09 0-.176.015-.26.04a2.497 2.497 0 00-2.487-2.36c-.163 0-.322.02-.476.057z"/>
         </svg>`
        : `<svg class="track-icon" viewBox="0 0 24 24" fill="${z.color}" width="12" height="12">
           <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424a.622.622 0 01-.857.207c-2.348-1.435-5.304-1.76-8.785-.964a.622.622 0 11-.277-1.215c3.809-.87 7.076-.496 9.712 1.115a.623.623 0 01.207.857zm1.223-2.722a.78.78 0 01-1.072.257c-2.687-1.652-6.785-2.13-9.965-1.166a.78.78 0 01-.973-.519.781.781 0 01.52-.972c3.633-1.102 8.147-.568 11.233 1.328a.78.78 0 01.257 1.072zm.105-2.835C14.692 8.95 9.375 8.775 6.297 9.71a.937.937 0 11-.543-1.795c3.528-1.068 9.396-.862 13.105 1.333a.938.938 0 01-.945 1.619z"/>
         </svg>`
    }
      <span class="track-label" title="${esc(t.url)}">${esc(t.label || t.uri || '')}</span>
      <div class="track-vol-wrap">
        <svg class="track-vol-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
          <path d="M15.54 8.46a5 5 0 010 7.07"/>
        </svg>
        <input class="track-vol-slider" type="range" min="0" max="100" value="${t.volume ?? 100}"
          data-zone="${z.id}" data-idx="${i}">
      </div>
      <button class="track-del" data-zone="${z.id}" data-idx="${i}">✕</button>
    </div>
  `).join('');

    div.innerHTML = `
  <div class="music-header">
    <div class="music-pip" style="background:${z.color}"></div>
    <span class="music-zone-name" data-zone="${z.id}">${esc(z.name)}</span>
    <button class="shuffle-btn ${z.shuffle ? 'on' : ''}" data-zone="${z.id}" title="Shuffle">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
        <polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
      </svg>
    </button>
    <span class="track-count">${z.playlist.length} track${z.playlist.length !== 1 ? 's' : ''}</span>
  </div>  
    ${tracksHtml || '<div class="no-tracks">No tracks yet</div>'}
    <div class="add-track-row">
      <input class="spotify-inp add-track-inp" placeholder="Paste Spotify or SoundCloud link…"
        title="A Spotify song link, or any SoundCloud link: song, playlist, album, profile or likes page">
      <button class="add-track-btn" data-zone="${z.id}">Add</button>
    </div>
    <button class="browse-sp-btn" data-zone="${z.id}">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="${SPOTIFY_ICON_PATH}"/></svg>
      Pick from my Spotify
    </button>
  `;

    div.querySelector('.browse-sp-btn').addEventListener('click', () => openLibrary(z.id));

    // Add track on button click
    div.querySelector('.add-track-btn').addEventListener('click', e => {
      const inp = div.querySelector('.add-track-inp');
      addTrack(z.id, inp.value);
      inp.value = '';
    });
    // Add track on Enter
    div.querySelector('.add-track-inp').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        addTrack(z.id, e.target.value);
        e.target.value = '';
      }
    });
    // Remove track buttons
    div.querySelectorAll('.track-del').forEach(btn => {
      btn.addEventListener('click', () => removeTrack(+btn.dataset.zone, +btn.dataset.idx));
    });

    div.querySelector('.shuffle-btn').addEventListener('click', e => {
      e.stopPropagation();
      toggleShuffle(z.id);
    });

    div.querySelectorAll('.track-vol-slider').forEach(slider => {
      slider.addEventListener('input', e => {
        e.stopPropagation();
        const zid = +slider.dataset.zone;
        const idx = +slider.dataset.idx;
        const zone = getZone(zid);
        if (!zone) return;
        zone.playlist[idx].volume = +slider.value;
        if (queue[queueIndex] === zone.playlist[idx]) {
          syncVolumeSlider(+slider.value);
          stopVolumeRamp();   // a manual change wins over an enter/exit fade
          setPlayerVolume(zone.playlist[idx].type, +slider.value);
        }
      });
        slider.addEventListener('change', () => saveZones());
      });

    ml.appendChild(div);
  });

  syncZoneArt();
  updateZoneGlow();   // zones may have been redrawn or deleted
}

// ── SIDEBAR TOGGLE ────────────────────────────────────────────────────────────
function toggleSidebar(collapse) {
  const app = document.querySelector('.app');
  const collapsed = app.classList.toggle('sidebar-collapsed', collapse);
  const btn = document.getElementById('btnSidebar');
  const label = collapsed ? 'Show sidebar' : 'Hide sidebar';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-expanded', String(!collapsed));
  try { localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0'); } catch (e) {}
  // Leaflet needs to re-measure once the map area has resized
  setTimeout(() => map.invalidateSize(), 220);
}

try {
  if (localStorage.getItem('sidebarCollapsed') === '1') toggleSidebar(true);
} catch (e) {}

// ── ZOOM TO ZONE ──────────────────────────────────────────────────────────────
// Double-clicking (or double-tapping) a zone in the sidebar list, or the zone chip in the map
// toolbar, zooms the map to that zone.
const DOUBLE_CLICK_MS = 400;

function zoomToZone(id) {
  const z = getZone(id);
  if (!z) return;
  if (!z.layer) {
    showToast(`${z.name} isn't drawn on the map yet`);
    return;
  }
  // On a phone the map sits above the list; bring it back into view first
  document.getElementById('map').scrollIntoView({ block: 'nearest' });
  const bounds = z.layer.getBounds();
  const options = { padding: [40, 40], maxZoom: 18 };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) map.fitBounds(bounds, options);
  else map.flyToBounds(bounds, { ...options, duration: 0.8 });
}

// Counted by hand from clicks rather than using dblclick: the first click re-renders the list
// under the pointer, and iOS Safari doesn't send dblclick for a double tap.
function onDoubleClick(el, keyOf, handler) {
  let last = { key: null, time: 0 };
  el.addEventListener('click', e => {
    const key = keyOf(e);
    if (key == null) return;
    const now = performance.now();
    if (key === last.key && now - last.time < DOUBLE_CLICK_MS) {
      last = { key: null, time: 0 };
      handler(key);
    } else {
      last = { key, time: now };
    }
  });
}

onDoubleClick(document.getElementById('groupsList'), e => {
  const row = e.target.closest('.zone-row');
  // Not the row's buttons or name box, and not the tap that ends a hold-and-drag
  if (!row || e.target.closest('button, input') || touchDragJustEnded) return null;
  return +row.dataset.zoneId;
}, zoomToZone);
onDoubleClick(document.getElementById('chipWrap'), () => selectedZoneId, zoomToZone);

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getZone(id) { return zones.find(z => z.id === id); }

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let toastTimer;
function showToast(msg, ms = 2400) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

document.getElementById('newZoneName').addEventListener('keydown', e => {
  if (e.key === 'Enter') addZoneFromInput();
});
const newGroupEl = document.getElementById('newGroupName');
if (newGroupEl) newGroupEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') addGroup();
});

// ── SPOTIFY AUTH (PKCE) ───────────────────────────────────────────────────────


// PKCE helpers
function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
async function generatePKCE() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function startSpotifyAuth() {
  const { verifier, challenge } = await generatePKCE();
  sessionStorage.setItem('sp_verifier', verifier);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     SP_CLIENT_ID,
    scope:         SP_SCOPES,
    redirect_uri:  SP_REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  window.location = 'https://accounts.spotify.com/authorize?' + params;
}

async function exchangeCode(code) {
  const verifier = sessionStorage.getItem('sp_verifier');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  SP_REDIRECT_URI,
      client_id:     SP_CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  const data = await res.json();
  if (data.access_token) {
    spotifyToken = data.access_token;
    // Store with expiry
    const expiry = Date.now() + (data.expires_in - 60) * 1000;
    sessionStorage.setItem('sp_token', spotifyToken);
    sessionStorage.setItem('sp_expiry', expiry);
    if (data.refresh_token) sessionStorage.setItem('sp_refresh', data.refresh_token);
    if (data.scope != null) sessionStorage.setItem('sp_scope', data.scope);
    sessionStorage.setItem('sp_client', SP_CLIENT_ID);
    sessionStorage.removeItem('sp_verifier');
    // Clean URL
    history.replaceState({}, '', window.location.pathname);
    return true;
  }
  console.error('Token exchange failed', data);
  return false;
}

async function refreshToken() {
  const refresh = sessionStorage.getItem('sp_refresh');
  if (!refresh) return false;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refresh,
      client_id:     SP_CLIENT_ID,
    }),
  });
  const data = await res.json();
  if (data.access_token) {
    spotifyToken = data.access_token;
    const expiry = Date.now() + (data.expires_in - 60) * 1000;
    sessionStorage.setItem('sp_token', spotifyToken);
    sessionStorage.setItem('sp_expiry', expiry);
    if (data.scope != null) sessionStorage.setItem('sp_scope', data.scope);
    return true;
  }
  return false;
}

async function ensureToken() {
  const expiry = parseInt(sessionStorage.getItem('sp_expiry') || '0');
  if (Date.now() > expiry) return await refreshToken();
  return true;
}

// ── SPOTIFY WEB PLAYBACK SDK ──────────────────────────────────────────────────
window.onSpotifyWebPlaybackSDKReady = () => {
  if (!spotifyToken) return; // will init after auth
  initPlayer();
};

function initPlayer() {
  if (spotifyPlayer) return; // never register a second Spotify device
  let authRetried = false;
  spotifyPlayer = new Spotify.Player({
    name: 'ZoneTune',
    getOAuthToken: async cb => {
      await ensureToken();
      cb(spotifyToken);
    },
    volume: 0.8,
  });

  spotifyPlayer.addListener('ready', ({ device_id }) => {
    spotifyDeviceId = device_id;
    playerReady = true;
    spotifyPlayerError = null;
    console.log('Spotify player ready, device:', device_id);
    showToast('Spotify player ready ✓');
    // The person may already be inside a zone (entered while we were connecting)
    if (pendingSpotifyTrack && currentZoneId != null) {
      const track = pendingSpotifyTrack;
      pendingSpotifyTrack = null;
      playQueueItem(track).catch(e => console.error('Deferred playback failed', e));
    }
  });

  spotifyPlayer.addListener('not_ready', ({ device_id }) => {
    playerReady = false;
    console.warn('Player went offline');
  });

  spotifyPlayer.addListener('player_state_changed', state => {
<<<<<<< HEAD
    onSpotifyState(state);
=======
    if (!state) return;
    // Started for a zone the person has already left (see zoneGen)
    if (!state.paused && !mayPlay('spotify')) spotifyPlayer.pause().catch(() => {});
    // Only update UI,  on't advance queue — advanceQueue is called explicitly
    updatePlayerUI(state);
>>>>>>> 312b56b1fca426800ef113477e8718c43aa81485
  });

  spotifyPlayer.addListener('initialization_error', ({ message }) => {
    spotifyPlayerError = message;
    showToast('Player init error: ' + message, 6000);
  });
  spotifyPlayer.addListener('authentication_error', async ({ message }) => {
    console.error('Spotify authentication_error:', message);
    playerReady = false;
    spotifyPlayerError = 'Spotify rejected the login (' + message + ')';
    // Retry once with a fresh token (before, a successful refresh left the player dead)
    if (!authRetried && await refreshToken().catch(() => false)) {
      authRetried = true;
      connectPlayer();
      return;
    }
    showToast(spotifyPlayerError + ' — please log in again', 6000);
    document.getElementById('spOverlay').classList.remove('hidden');
  });
  spotifyPlayer.addListener('account_error', ({ message }) => {
    spotifyPlayerError = 'Spotify Premium required for playback';
    showToast(spotifyPlayerError, 6000);
  });
  spotifyPlayer.addListener('playback_error', ({ message }) => {
    console.error('Spotify playback_error:', message);
    showToast('Spotify playback error: ' + message, 6000);
  });
  spotifyPlayer.addListener('autoplay_failed', () => {
    // The browser's autoplay policy stopped the SDK from starting audio by itself
    showToast('Your browser blocked autoplay — press ▶ to start the music', 6000);
    document.getElementById('nowPlaying').classList.add('show');
  });

  function connectPlayer() {
    spotifyPlayer.connect().then(connected => {
      if (connected) return;
      // The SDK can fail to connect without emitting any error event
      spotifyPlayerError = spotifyPlayerError || 'could not connect. Needs a Premium account, and in Development Mode the account must be listed under User Management in the Spotify dashboard';
      console.error('Spotify player.connect() failed:', spotifyPlayerError);
      showToast('Spotify player unavailable: ' + spotifyPlayerError, 8000);
    }).catch(e => console.error('Spotify player.connect() threw', e));
  }
  connectPlayer();
}

// Browsers with strict autoplay rules only let the SDK play audio if its media
// element was unlocked during a user gesture (click/tap). Call from click handlers.
function activateSpotifyElement() {
  if (spotifyPlayer && typeof spotifyPlayer.activateElement === 'function') {
    spotifyPlayer.activateElement().catch(() => {});
  }
}

// ── SPOTIFY PLAYBACK API ──────────────────────────────────────────────────────
function extractSpotifyUri(url) {
  // Handle spotify: URIs directly
  if (url.startsWith('spotify:')) return url;
  // Parse https://open.spotify.com/track/xxx or playlist/xxx
  const m = url.match(/spotify\.com\/(track|playlist|album|artist)\/([a-zA-Z0-9]+)/);
  if (m) return `spotify:${m[1]}:${m[2]}`;
  return null;
}

async function playSpotifyUri(uri) {
  if (!playerReady || !spotifyDeviceId) {
    showToast('Player not ready yet…');
    return;
  }
  await ensureToken();

  const isTrack    = uri.startsWith('spotify:track:');
  const isPlaylist = uri.includes(':playlist:');
  const isAlbum    = uri.includes(':album:');

  const body = isTrack
    ? { uris: [uri] }
    : { context_uri: uri };

  const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`, {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + spotifyToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 204 || res.status === 200) {
    currentlyPlaying = true;
    document.getElementById('nowPlaying').classList.add('show');
  } else {
    const err = await res.json().catch(() => ({}));
    showToast('Playback error: ' + (err.error?.message || res.status));
  }
}

async function playTrackList(uris, retried = false) {
  if (!playerReady || !spotifyDeviceId || !uris.length) return;
  await ensureToken();
  const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`, {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + spotifyToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uris }),  // plays all tracks in order
  });
  if (res.ok) {
    currentlyPlaying = true;
    document.getElementById('nowPlaying').classList.add('show');
  } else if (res.status === 404 && !retried) {
    // "Device not found": a just-connected SDK device isn't always visible to the
    // Web API yet. Make it the active device, then try once more.
    await transferPlaybackHere();
    await playTrackList(uris, true);
  } else {
    showToast('Playback error: ' + await spotifyErrorText(res), 6000);
  }
}

async function transferPlaybackHere() {
  await fetch('https://api.spotify.com/v1/me/player', {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + spotifyToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ device_ids: [spotifyDeviceId], play: false }),
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 1000));
}

// Spotify errors are usually JSON ({ error: { message } }), but the Development
// Mode "user not registered" 403 is plain text, so read both.
async function spotifyErrorText(res) {
  const text = await res.text().catch(() => '');
  let msg = text;
  try { msg = JSON.parse(text).error?.message || text; } catch (e) {}
  if (/not be registered|not registered/i.test(msg)) {
    msg = 'this Spotify account is not added to the app (Spotify dashboard → User Management)';
  }
  return `${msg || 'request failed'} (${res.status})`;
}

async function spotifyTogglePlay() {
  const track = queue[queueIndex];
  // Pressing play by hand is allowed even outside a zone
  playGen = zoneGen;
  playType = track?.type === 'soundcloud' ? 'soundcloud' : 'spotify';
  if (track?.type === 'soundcloud') {
    if (scWidget && scReady) scWidget.toggle();
  } else {
    if (!spotifyPlayer) return;
    if (!currentlyPlaying) activateSpotifyElement(); // this click counts as a user gesture
    await spotifyPlayer.togglePlay();
  }
}

async function spotifyNext() {
  await advanceQueue();
}

async function spotifyPrev() {
  queueIndex = queueIndex <= 0 ? queue.length - 2 : queueIndex - 2;
  await advanceQueue();
}

async function setVolume(val) {
  const track = queue[queueIndex];
  if (track) {
    track.volume = +val;
    // Update the matching per-track slider if visible
    const slider = document.querySelector(
      `.track-vol-slider[data-zone="${currentZoneId}"][data-idx="${queueIndex}"]`
    );
    if (slider) slider.value = val;
  }
  stopVolumeRamp();   // a manual change wins over an enter/exit fade
  await setPlayerVolume(track?.type === 'soundcloud' ? 'soundcloud' : 'spotify', +val);
}

async function seekTo(e) {
  if (!spotifyPlayer || !trackDuration) return;
  const bar = document.getElementById('npBar');
  const rect = bar.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  await spotifyPlayer.seek(Math.floor(pct * trackDuration));
}


function toggleShuffle(zoneId) {
  const z = getZone(zoneId);
  if (!z) return;
  z.shuffle = !z.shuffle;
  refreshQueue(z);
  saveZones();
  render();
  showToast(z.shuffle ? `Shuffle on for ${z.name}` : `Shuffle off for ${z.name}`);
}

function shuffleArray(arr) {  //helper function
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function updatePlayerUI(state) {
  if (!state) return;
  const track = state.track_window?.current_track;
  if (!track) return;

  currentlyPlaying = !state.paused;
  updateZoneGlow();
  trackDuration = state.duration;
  trackPosition = state.position;

  // Art
  const artEl = document.getElementById('npArt');
  const imgUrl = track.album?.images?.[0]?.url;
  artEl.innerHTML = imgUrl
    ? `<img src="${imgUrl}" alt="album art">`
    : `<svg class="np-art-placeholder" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M9.5 8.5l7 3.5-7 3.5V8.5z" fill="currentColor"/></svg>`;

  document.getElementById('npTrack').textContent  = track.name || '—';
  document.getElementById('npArtist').textContent = (track.artists || []).map(a => a.name).join(', ');

  // Play/pause icon
  const icon = document.getElementById('npPlayIcon');
  icon.innerHTML = state.paused
    ? '<path d="M8 5v14l11-7z"/>'
    : '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';

  // Progress
  updateProgress(state.position, state.duration);

  // Show player bar (only for playing music: pausing as the person is removed
  // from the map must not bring back the bar removePerson() just hid)
  if (!state.paused) document.getElementById('nowPlaying').classList.add('show');

  // Kick off local progress timer
  clearInterval(progressTimer);
  if (!state.paused) {
    const startedAt = Date.now();
    const startPos  = state.position;
    progressTimer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const pos = Math.min(startPos + elapsed, trackDuration);
      updateProgress(pos, trackDuration);
      if (pos >= trackDuration) clearInterval(progressTimer);
    }, 500);
  }
}

// Every state update from the Spotify player
function onSpotifyState(state) {
  if (!state) return;
  checkSpotifySongEnded(state);   // first, so the glow is held before the UI sees "paused"
  updatePlayerUI(state);
}

// The Web Playback SDK has no "song ended" event, so watch the song we started for its end: it
// stops at the start after having played to the end, or Spotify moves on to a song of its own
// (autoplay). Either way the zone's next song plays.
let spotifyWatch = null;   // { uri, position, duration, at } from the last update while our song played

function checkSpotifySongEnded(state) {
  const expected = queue[queueIndex];
  if (expected?.type !== 'spotify') { spotifyWatch = null; return; }
  const cur = state.track_window?.current_track;
  const isOurs = (cur?.linked_from?.uri || cur?.uri) === expected.uri;
  if (isOurs && !state.paused) {
    spotifyWatch = { uri: expected.uri, position: state.position, duration: state.duration, at: Date.now() };
    return;
  }
  // Only once our song has been seen playing; ignores late updates about the song before it
  const watch = spotifyWatch?.uri === expected.uri ? spotifyWatch : null;
  spotifyWatch = null;
  if (!watch) return;
  const playedTo = watch.position + (Date.now() - watch.at);
  const stoppedAtEnd = state.paused
    && (state.position === 0 || state.position >= watch.duration - Math.min(1500, watch.duration * 0.05))
    && playedTo >= watch.duration - Math.min(3000, watch.duration * 0.1);
  const spotifyMovedOn = !isOurs && !state.paused;
  // Anything else is a pause part-way through (by the user or a fade-out): nothing to do
  if (stoppedAtEnd || spotifyMovedOn) autoAdvance();
}

function updatePlayerUIForSoundcloud() {
  const track = queue[queueIndex];
  if (!track) return;

  document.getElementById('npTrack').textContent = track.label || 'SoundCloud track';
  document.getElementById('npArtist').textContent = 'SoundCloud';

  const artEl = document.getElementById('npArt');
  artEl.innerHTML = track.artworkUrl
    ? `<img src="${track.artworkUrl}" alt="artwork">`
    : `<svg class="np-art-placeholder" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M9.5 8.5l7 3.5-7 3.5V8.5z" fill="currentColor"/></svg>`;

  document.getElementById('nowPlaying').classList.add('show');

  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (!scWidget || !scReady) return;
    scWidget.getPosition(pos => {
      scWidget.getDuration(dur => {
        updateProgress(pos, dur);
      });
    });
  }, 500);
}

function updateProgress(pos, dur) {
  if (!dur) return;
  const pct = (pos / dur) * 100;
  document.getElementById('npFill').style.width = pct + '%';
  document.getElementById('npTimeCur').textContent = msToTime(pos);
  document.getElementById('npTimeDur').textContent = msToTime(dur);
}

function msToTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}

// ── SPOTIFY LIBRARY BROWSER ───────────────────────────────────────────────────
// Lists the user's playlists and Liked Songs, and searches all of Spotify, so
// songs can be assigned to a zone with a click instead of pasting URLs, and ♥'d
// into Liked Songs. open.spotify.com refuses to load inside a frame, so the same
// data comes from the Web API and is drawn here.
const LIBRARY_SCOPES = ['playlist-read-private', 'playlist-read-collaborative', 'user-library-read', 'user-library-modify'];
const LIKED_SONGS = 'liked';
const LIKED_SONGS_URL = 'https://open.spotify.com/collection/tracks';
const SEARCH = 'search'; // sourceId while showing search results
const HEART_PATH = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';
const OWN_PLAYLISTS_ONLY = "Spotify only lets apps read the songs in playlists you own or collaborate on. " +
  "Add this playlist's songs to your Liked Songs (or to a playlist of your own) to pick them here.";

const lib = {
  zoneId: null,          // zone that clicked songs are added to
  meId: null,            // Spotify user id, to tell own playlists from followed ones
  playlists: null,       // null until the first page has loaded
  playlistsNext: null,
  loadingSources: false,
  sourcesError: null,
  gen: 0,                // bumped whenever another list is opened, to drop stale pages
  sourceId: null,        // playlist id, LIKED_SONGS or SEARCH
  source: null,          // the open playlist object (null for Liked Songs / search)
  query: '',             // search text while sourceId is SEARCH
  tracks: [],
  tracksNext: null,
  tracksLoaded: false,
  loadingTracks: null,   // in-flight page request, so callers can await it
  tracksError: null,
  liked: new Map(),      // track uri → in Liked Songs (missing = not checked yet)
  likePending: new Set(),// track uris with a like/unlike request in flight
};
let libBackdropDown = false;
let libSearchTimer = null;

// Calls the Web API (GET unless `method` says otherwise). Paging links are
// absolute URLs; the token is only ever sent to api.spotify.com.
async function spotifyApi(pathOrUrl, { method = 'GET' } = {}, retried = false) {
  const url = pathOrUrl.startsWith('/') ? 'https://api.spotify.com/v1' + pathOrUrl : pathOrUrl;
  if (!url.startsWith('https://api.spotify.com/')) throw new Error('Unexpected Spotify URL');
  await ensureToken();
  const res = await fetch(url, { method, headers: { 'Authorization': 'Bearer ' + spotifyToken } });
  if (res.status === 401 && !retried && await refreshToken().catch(() => false)) {
    return spotifyApi(url, { method }, true);
  }
  if (!res.ok) {
    const err = new Error(await spotifyErrorText(res));
    err.status = res.status;
    throw err;
  }
  const text = await res.text(); // saving to / removing from the library replies with no body
  return text ? JSON.parse(text) : null;
}

// Logins from before the library browser existed lack these scopes
function hasLibraryScopes() {
  const granted = (sessionStorage.getItem('sp_scope') || '').split(' ');
  return LIBRARY_SCOPES.every(s => granted.includes(s));
}

function openLibrary(zoneId) {
  if (!spotifyToken) {
    showToast('Connect Spotify to browse your playlists');
    document.getElementById('spOverlay').classList.remove('hidden');
    return;
  }
  lib.zoneId = getZone(zoneId) ? zoneId : getZone(lib.zoneId) ? lib.zoneId : selectedZoneId;
  const sel = document.getElementById('libZoneSelect');
  sel.innerHTML = zones.map(z => `<option value="${z.id}">${esc(z.name)}</option>`).join('');
  sel.value = lib.zoneId ?? '';
  updateLibraryZoneDot();
  document.getElementById('libNotice').hidden = hasLibraryScopes();
  document.getElementById('libOverlay').classList.remove('hidden');
  renderLibraryTracks(); // zones may have changed since it was last open
  loadLibrarySources(true); // pick up playlists made since last time
  if (!isTouchScreen) document.getElementById('libSearch').focus(); // no surprise keyboard on phones
}

function closeLibrary() {
  document.getElementById('libOverlay').classList.add('hidden');
}

function updateLibraryZoneDot() {
  const z = getZone(lib.zoneId);
  document.getElementById('libZoneDot').style.background = z ? z.color : 'transparent';
}

function libraryError(e) {
  if (e.status === 401 || (e.status === 403 && !hasLibraryScopes())) {
    return { text: 'Reconnect Spotify so ZoneTune can read your playlists and Liked Songs and save songs you ♥.', action: 'reconnect' };
  }
  return { text: e.message, action: 'retry' };
}

function libraryErrorHtml(err, retryAction) {
  const btn = err.action === 'reconnect'
    ? '<button class="btn" data-action="reconnect">Reconnect Spotify</button>'
    : err.action === 'retry'
      ? `<button class="btn btn-secondary" data-action="${retryAction}">Try again</button>`
      : '';
  return `<div class="lib-empty">${esc(err.text)}${btn ? '<br>' + btn : ''}</div>`;
}

async function loadLibrarySources(reset = false) {
  if (lib.loadingSources) return;
  lib.loadingSources = true;
  lib.sourcesError = null;
  renderLibrarySources();
  try {
    if (!lib.meId) lib.meId = await spotifyApi('/me').then(u => u.id, () => null);
    const page = await spotifyApi((!reset && lib.playlistsNext) || '/me/playlists?limit=50');
    const items = (page.items || []).filter(Boolean);
    lib.playlists = reset ? items : [...(lib.playlists || []), ...items];
    lib.playlistsNext = page.next;
  } catch (e) {
    lib.sourcesError = libraryError(e);
  } finally {
    lib.loadingSources = false;
    renderLibrarySources();
  }
}

function canReadPlaylist(p) {
  return !lib.meId || p.owner?.id === lib.meId || p.collaborative;
}

function smallestImage(images) {
  return images?.length ? images[images.length - 1].url : null; // Spotify sorts largest first
}

function renderLibrarySources() {
  const html = [`
    <button class="lib-source${lib.sourceId === LIKED_SONGS ? ' on' : ''}" data-source="${LIKED_SONGS}">
      <span class="lib-cover liked">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="${HEART_PATH}"/></svg>
      </span>
      <span class="lib-source-text">
        <span class="lib-source-name">Liked Songs</span>
        <span class="lib-source-meta">Your saved songs</span>
      </span>
    </button>`];

  (lib.playlists || []).forEach(p => {
    const readable = canReadPlaylist(p);
    const img = smallestImage(p.images);
    const total = (p.items || p.tracks)?.total; // `tracks` is the pre-2026 field name
    const meta = !readable
      ? `by ${esc(p.owner?.display_name || 'someone else')} · songs hidden`
      : total != null ? `${total} song${total !== 1 ? 's' : ''}` : 'Playlist';
    html.push(`
      <button class="lib-source${lib.sourceId === p.id ? ' on' : ''}${readable ? '' : ' locked'}" data-source="${esc(p.id)}">
        <span class="lib-cover">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : '♫'}</span>
        <span class="lib-source-text">
          <span class="lib-source-name">${esc(p.name || 'Untitled playlist')}</span>
          <span class="lib-source-meta">${meta}</span>
        </span>
      </button>`);
  });

  if (lib.loadingSources) html.push('<div class="lib-empty">Loading playlists…</div>');
  else if (lib.sourcesError) html.push(libraryErrorHtml(lib.sourcesError, 'more-sources'));
  else if (lib.playlistsNext) html.push('<button class="btn btn-secondary lib-more" data-action="more-sources">More playlists</button>');

  document.getElementById('libSources').innerHTML = html.join('');
}

// Empties the song list and switches it to another source (null = nothing open)
function resetLibraryList(id) {
  lib.gen++;
  lib.sourceId = id;
  lib.source = (lib.playlists || []).find(p => p.id === id) || null;
  lib.tracks = [];
  lib.tracksNext = null;
  lib.tracksLoaded = false;
  lib.loadingTracks = null;
  lib.tracksError = null;
  document.getElementById('libFilter').value = '';
  document.getElementById('libBody').classList.toggle('showing-tracks', !!id);
  renderLibrarySources();
}

function openLibrarySource(id) {
  clearTimeout(libSearchTimer); // a search still waiting to run would replace this list
  document.getElementById('libSearch').value = '';
  resetLibraryList(id);

  if (lib.source && !canReadPlaylist(lib.source)) {
    lib.tracksError = { text: OWN_PLAYLISTS_ONLY, action: null };
    renderLibraryTracks();
    return;
  }
  loadLibraryTracksPage();
}

function searchLibrary(raw) {
  clearTimeout(libSearchTimer);
  const q = raw.trim();
  if (!q) {
    if (lib.sourceId === SEARCH) { resetLibraryList(null); renderLibraryTracks(); }
    return;
  }
  if (lib.sourceId === SEARCH && q === lib.query) return; // Enter right after the typing pause
  resetLibraryList(SEARCH);
  lib.query = q;
  loadLibraryTracksPage();
}

// Loads the next page of the open list. Resolves to false when nothing was
// added (it failed, the list is complete, or another list was opened meanwhile).
function loadLibraryTracksPage() {
  if (lib.loadingTracks) return lib.loadingTracks;
  if (!lib.sourceId || (lib.tracksLoaded && !lib.tracksNext)) return Promise.resolve(false);

  const gen = lib.gen;
  const searching = lib.sourceId === SEARCH;
  const url = lib.tracksNext || (searching
    ? `/search?type=track&limit=10&q=${encodeURIComponent(lib.query)}` // 10 is the API's maximum
    : lib.sourceId === LIKED_SONGS
      ? '/me/tracks?limit=50'
      : `/playlists/${encodeURIComponent(lib.sourceId)}/items?limit=50`);
  lib.tracksError = null;
  lib.loadingTracks = spotifyApi(url).then(data => {
    if (gen !== lib.gen) return false;
    // Search returns bare tracks under `tracks`; library lists wrap each song
    const page = searching ? data.tracks || {} : data;
    const entries = searching ? (page.items || []).map(t => ({ track: t })) : page.items || [];
    const added = entries.map(libraryTrackFromEntry).filter(Boolean);
    lib.tracks.push(...added);
    lib.tracksNext = page.next;
    lib.tracksLoaded = true;
    refreshLikedState(added);
    return true;
  }, e => {
    if (gen === lib.gen) lib.tracksError = libraryError(e);
    return false;
  }).finally(() => {
    if (gen !== lib.gen) return;
    lib.loadingTracks = null;
    renderLibraryTracks();
  });
  renderLibraryTracks();
  return lib.loadingTracks;
}

// Playlist entries hold the song in `item` (`track` before the 2026 API change);
// Liked Songs entries hold it in `track`.
function libraryTrackFromEntry(entry) {
  const t = entry?.item || entry?.track;
  if (!t) return null; // removed from Spotify
  const local = entry.is_local || t.is_local;
  const playable = t.type === 'track' && !local && /^[A-Za-z0-9]+$/.test(t.id || '');
  return {
    id: playable ? t.id : null,
    uri: playable ? 'spotify:track:' + t.id : null,
    name: t.name || 'Untitled',
    artists: (t.artists || []).map(a => a.name).join(', '),
    album: t.album?.name || '',
    art: smallestImage(t.album?.images),
    duration: t.duration_ms || 0,
    playable,
    reason: local ? "Local file — Spotify can't stream it"
          : t.type === 'episode' ? "Podcast episodes can't be added to zones" : '',
  };
}

// Asks Spotify which of these songs are in Liked Songs (40 per request) so their
// ♥ shows filled. Songs it can't check just show an empty ♥.
async function refreshLikedState(tracks) {
  const uris = [...new Set(tracks.filter(t => t.playable).map(t => t.uri))];
  if (lib.sourceId === LIKED_SONGS) {
    uris.forEach(u => lib.liked.set(u, true));
    updateLibraryTrackRows();
    return;
  }
  for (let i = 0; i < uris.length; i += 40) {
    const chunk = uris.slice(i, i + 40);
    try {
      const flags = await spotifyApi('/me/library/contains?uris=' + chunk.map(encodeURIComponent).join(','));
      chunk.forEach((u, j) => { if (!lib.likePending.has(u)) lib.liked.set(u, !!flags?.[j]); });
    } catch (e) {
      return;
    }
    updateLibraryTrackRows();
  }
}

function visibleLibraryTracks() {
  const q = document.getElementById('libFilter').value.trim().toLowerCase();
  if (!q) return lib.tracks;
  return lib.tracks.filter(t => `${t.name} ${t.artists} ${t.album}`.toLowerCase().includes(q));
}

function zoneHasTrack(z, uri) {
  return z.playlist.some(t => t.uri === uri);
}

function renderLibraryTracks() {
  const liked = lib.sourceId === LIKED_SONGS;
  const searching = lib.sourceId === SEARCH;
  const p = lib.source;
  const spUrl = searching ? 'https://open.spotify.com/search/' + encodeURIComponent(lib.query)
    : liked ? LIKED_SONGS_URL : p?.external_urls?.spotify || '';
  const openLink = document.getElementById('libOpenSp');
  openLink.hidden = !spUrl.startsWith('https://open.spotify.com/');
  if (!openLink.hidden) openLink.href = spUrl;
  document.getElementById('libSrcName').textContent =
    searching ? `Results for “${lib.query}”` : liked ? 'Liked Songs' : p?.name || 'Songs';
  // Search results are already what was asked for: no filter box or "Add all"
  document.getElementById('libFilterRow').hidden = !lib.sourceId || searching;

  const el = document.getElementById('libTracks');
  const addAll = document.getElementById('libAddAll');
  if (!lib.sourceId) {
    el.innerHTML = '';
    addAll.hidden = true;
    return;
  }

  const z = getZone(lib.zoneId);
  const shown = visibleLibraryTracks();
  let html = shown.map(t => {
    const added = !!z && t.playable && zoneHasTrack(z, t.uri);
    return `
    <div class="lib-row">
      <button class="lib-track${added ? ' added' : ''}"
        ${t.playable ? `data-track="${t.id}" aria-pressed="${added}"` : `disabled title="${esc(t.reason)}"`}>
        <span class="lib-cover">${t.art ? `<img src="${esc(t.art)}" alt="" loading="lazy">` : '♫'}</span>
        <span class="lib-track-text">
          <span class="lib-track-name">${esc(t.name)}</span>
          <span class="lib-track-artist">${esc(t.reason || [t.artists, t.album].filter(Boolean).join(' · '))}</span>
        </span>
        <span class="lib-track-dur">${t.duration ? msToTime(t.duration) : ''}</span>
        <span class="lib-track-act" aria-hidden="true"></span>
      </button>
      ${t.playable
        ? `<button class="lib-like" data-like="${t.id}">
             <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="${HEART_PATH}"/></svg>
           </button>`
        : '<span class="lib-like-spacer"></span>'}
    </div>`;
  }).join('');

  if (lib.loadingTracks) html += `<div class="lib-empty">${searching ? 'Searching…' : 'Loading songs…'}</div>`;
  else if (lib.tracksError) html += libraryErrorHtml(lib.tracksError, 'more-tracks');
  else if (lib.tracksNext) html += `<button class="btn btn-secondary lib-more" data-action="more-tracks">${searching ? 'More results' : 'Load more songs'}</button>`;
  else if (!shown.length) {
    html += `<div class="lib-empty">${searching ? `No songs found for “${esc(lib.query)}”.`
      : lib.tracks.length ? 'No songs match your filter.' : 'No songs here yet.'}</div>`;
  }

  el.innerHTML = html;
  addAll.hidden = searching || !shown.some(t => t.playable);
  updateLibraryTrackRows();
}

// Refresh the added and ♥ marks without rebuilding the list (keeps focus)
function updateLibraryTrackRows() {
  const z = getZone(lib.zoneId);
  document.querySelectorAll('#libTracks .lib-track[data-track]').forEach(btn => {
    const added = !!z && zoneHasTrack(z, 'spotify:track:' + btn.dataset.track);
    btn.classList.toggle('added', added);
    btn.setAttribute('aria-pressed', String(added));
  });
  document.querySelectorAll('#libTracks .lib-like[data-like]').forEach(btn => {
    const uri = 'spotify:track:' + btn.dataset.like;
    const liked = !!lib.liked.get(uri);
    const label = liked ? 'Remove from Liked Songs' : 'Save to Liked Songs';
    btn.classList.toggle('liked', liked);
    btn.setAttribute('aria-pressed', String(liked));
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.disabled = lib.likePending.has(uri);
  });
}

// ♥ / un-♥ a song in the user's Liked Songs. The heart changes right away and
// changes back if Spotify refuses.
async function toggleLibraryLike(id) {
  const t = lib.tracks.find(x => x.id === id);
  if (!t || lib.likePending.has(t.uri)) return;
  const like = !lib.liked.get(t.uri);
  lib.liked.set(t.uri, like);
  lib.likePending.add(t.uri);
  updateLibraryTrackRows();
  try {
    await spotifyApi('/me/library?uris=' + encodeURIComponent(t.uri), { method: like ? 'PUT' : 'DELETE' });
    showToast(like ? `Saved to Liked Songs: ${t.name}` : `Removed from Liked Songs: ${t.name}`);
  } catch (e) {
    lib.liked.set(t.uri, !like);
    const err = libraryError(e);
    if (err.action === 'reconnect') {
      document.getElementById('libNotice').hidden = false;
      showToast('Reconnect Spotify (button at the top) to save songs you ♥', 6000);
    } else {
      showToast(`Couldn't update Liked Songs: ${err.text}`, 6000);
    }
  } finally {
    lib.likePending.delete(t.uri);
    updateLibraryTrackRows();
  }
}

// Same shape addTrack() stores for a pasted Spotify URL
function zoneTrackFromLibrary(t) {
  return {
    url: 'https://open.spotify.com/track/' + t.id,
    uri: t.uri,
    label: t.artists ? `${t.name} — ${t.artists}` : t.name,
    type: 'spotify',
    volume: 100,
  };
}

function toggleLibraryTrack(id) {
  const z = getZone(lib.zoneId);
  if (!z) { showToast('Add a zone first'); return; }
  const t = lib.tracks.find(x => x.id === id);
  if (!t) return;

  const idx = z.playlist.findIndex(x => x.uri === t.uri);
  if (idx >= 0) {
    removeTrack(z.id, idx);
    showToast(`Removed from ${z.name}: ${t.name}`);
  } else {
    if (z.playlist.length >= MAX_ZONE_TRACKS) { showToast(`Max ${MAX_ZONE_TRACKS} tracks per zone`); return; }
    z.playlist.push(zoneTrackFromLibrary(t));
    saveZones();
    render();
    showToast(`Added to ${z.name}: ${t.name}`);
  }
  updateLibraryTrackRows();
}

// Songs in the open list (matching the filter) that the zone doesn't have yet
function missingLibraryTracks(z) {
  const have = new Set(z.playlist.map(t => t.uri));
  return visibleLibraryTracks().filter(t => {
    if (!t.playable || have.has(t.uri)) return false;
    have.add(t.uri); // a playlist can list the same song twice
    return true;
  });
}

async function addAllLibraryTracks() {
  const z = getZone(lib.zoneId);
  if (!z) { showToast('Add a zone first'); return; }
  const gen = lib.gen;
  const btn = document.getElementById('libAddAll');
  btn.disabled = true;
  try {
    // Fetch the rest of the list, but only as much as the zone still has room for
    while (lib.tracksNext && missingLibraryTracks(z).length < MAX_ZONE_TRACKS - z.playlist.length) {
      if (!await loadLibraryTracksPage()) break;
    }
    if (gen !== lib.gen) return;

    const room = MAX_ZONE_TRACKS - z.playlist.length;
    const toAdd = missingLibraryTracks(z).slice(0, room);
    if (!toAdd.length) {
      showToast(room ? `Everything here is already in ${z.name}` : `${z.name} is full (max ${MAX_ZONE_TRACKS} tracks)`);
      return;
    }
    z.playlist.push(...toAdd.map(zoneTrackFromLibrary));
    saveZones();
    render();
    updateLibraryTrackRows();
    showToast(`Added ${toAdd.length} song${toAdd.length !== 1 ? 's' : ''} to ${z.name}` +
      (z.playlist.length >= MAX_ZONE_TRACKS ? ` (zone is now full: max ${MAX_ZONE_TRACKS})` : ''));
  } finally {
    btn.disabled = false;
  }
}

(() => {
  const overlay = document.getElementById('libOverlay');
  // Only close on a click that started on the backdrop (not a text drag that ended there)
  overlay.addEventListener('pointerdown', e => { libBackdropDown = e.target === overlay; });
  overlay.addEventListener('click', e => {
    if (e.target === overlay) { if (libBackdropDown) closeLibrary(); return; }
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.source) openLibrarySource(btn.dataset.source);
    else if (btn.dataset.like) toggleLibraryLike(btn.dataset.like);
    else if (btn.dataset.track) toggleLibraryTrack(btn.dataset.track);
    else switch (btn.dataset.action) {
      case 'close':        closeLibrary(); break;
      case 'back':         document.getElementById('libBody').classList.remove('showing-tracks'); break;
      case 'add-all':      addAllLibraryTracks(); break;
      case 'more-sources': loadLibrarySources(); break;
      case 'more-tracks':  loadLibraryTracksPage(); break;
      case 'reconnect':    startSpotifyAuth(); break;
    }
  });
  document.getElementById('libZoneSelect').addEventListener('change', e => {
    lib.zoneId = +e.target.value;
    updateLibraryZoneDot();
    updateLibraryTrackRows();
  });
  document.getElementById('libFilter').addEventListener('input', renderLibraryTracks);
  // Search once typing pauses (not on every keystroke), or right away on Enter
  const search = document.getElementById('libSearch');
  search.addEventListener('input', () => {
    clearTimeout(libSearchTimer);
    libSearchTimer = setTimeout(() => searchLibrary(search.value), 350);
  });
  search.addEventListener('keydown', e => { if (e.key === 'Enter') searchLibrary(search.value); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeLibrary();
  });
})();

// ── PERSON MARKER ────────────────────────────────────────────────────────────
let personMarker  = null;
let personVisible = false;
let currentZoneId = null;

// The new pulsing blue dot for live GPS
const gpsIcon = L.divIcon({
  className: 'gps-marker',
  iconSize: [16, 16],     
  iconAnchor: [8, 8]   
});

const personIcon = L.divIcon({
  className: '',
  html: `
    <div class="person-marker-wrap">
      <div class="person-pulse" id="personPulse"></div>
      <svg class="person-icon" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="20" cy="37" rx="8" ry="3" fill="rgba(0,0,0,0.4)"/>
        <circle cx="20" cy="11" r="7" fill="#c8ff47" stroke="#0b0b0e" stroke-width="1.5"/>
        <circle cx="17.5" cy="10" r="1.2" fill="#0b0b0e"/>
        <circle cx="22.5" cy="10" r="1.2" fill="#0b0b0e"/>
        <path d="M17 13 Q20 15.5 23 13" stroke="#0b0b0e" stroke-width="1.2" fill="none" stroke-linecap="round"/>
        <path d="M11 28 Q11 20 20 20 Q29 20 29 28 L29 34 L11 34 Z" fill="#c8ff47" stroke="#0b0b0e" stroke-width="1.5"/>
        <path d="M11 22 L6 28" stroke="#c8ff47" stroke-width="3" stroke-linecap="round"/>
        <path d="M29 22 L34 28" stroke="#c8ff47" stroke-width="3" stroke-linecap="round"/>
        <path d="M15 34 L13 40" stroke="#c8ff47" stroke-width="3" stroke-linecap="round"/>
        <path d="M25 34 L27 40" stroke="#c8ff47" stroke-width="3" stroke-linecap="round"/>
      </svg>
    </div>
  `,
  iconSize: [40, 44],
  iconAnchor: [20, 44],
});

function togglePerson() {
  // Add this safety check!
  if (isGpsActive) {
    showToast("Turn off GPS to use the manual person.");
    return;
  }
  personVisible ? removePerson() : placePerson();
}
function placePerson() {
  // While drawing, Leaflet.draw's invisible cursor marker sits on top of every
  // marker and swallows the mouse, so the person could never be dragged into a
  // zone. Switch to Navigate mode while the person is on the map.
  if (mode !== 'nav') setMode('nav');
  activateSpotifyElement(); // runs inside the "Add Person" click
  const center = map.getCenter();
  personMarker = L.marker(center, { icon: personIcon, draggable: true, zIndexOffset: 1000 }).addTo(map);
  personMarker.on('dragstart', () => map.dragging.disable());
  personMarker.on('drag',    () => checkPersonZone());
  personMarker.on('dragend', () => { map.dragging.enable(); checkPersonZone(); });
  personVisible = true;
  document.getElementById('btnPerson').classList.add('on');
  document.getElementById('btnPersonLabel').textContent = 'Remove Person';
  checkPersonZone();
}

function removePerson() {
  if (personMarker) { map.removeLayer(personMarker); personMarker = null; }
  personVisible = false;
<<<<<<< HEAD
  if (currentZoneId != null) {   // taking the person off the map counts as leaving the zone
    currentZoneId = null;
    onPersonZoneChange(null);
  }
=======
  currentZoneId = null;
  // No person, no zone: stop the music (the player bar is hidden below, so it
  // couldn't be paused by hand either)
  zoneGen++;
  stopZoneMusic();
>>>>>>> 312b56b1fca426800ef113477e8718c43aa81485
  document.getElementById('btnPerson').classList.remove('on');
  document.getElementById('btnPersonLabel').textContent = 'Add Person';
  document.getElementById('nowPlaying').classList.remove('show');
}

function toggleGPS() {
  const btn = document.getElementById('btnGps');
  const label = document.getElementById('btnGpsLabel');

  // Turn GPS OFF
  if (isGpsActive) {
    if (gpsWatchId) navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
    isGpsActive = false;
    
    btn.classList.remove('on');
    label.textContent = 'Start GPS';
    
    // Wipe the marker from the map and stop music
    removePerson();
    return;
  }

  // Check browser support
  if (!navigator.geolocation) {
    showToast("Geolocation is not supported by your browser.");
    return;
  }

  // Turn GPS ON
  isGpsActive = true;
  btn.classList.add('on');
  label.textContent = 'Stop GPS';
  activateSpotifyElement(); // runs inside the "Start GPS" click

  // Override: If the manual person is currently on the map, wipe it!
  if (personVisible) {
    removePerson(); 
  }

  gpsWatchId = navigator.geolocation.watchPosition(
    (position) => {
      const latlng = [position.coords.latitude, position.coords.longitude];

      if (!personMarker) {
        // First ping: create the marker using the new GPS icon!
        personMarker = L.marker(latlng, { 
          icon: gpsIcon,     // <--- CHANGED THIS LINE
          draggable: false, 
          zIndexOffset: 1000 
        }).addTo(map);
        
        personVisible = true;
        map.setView(latlng, 17); // Snap camera to your real location
      } else {
        // Subsequent pings: just move the marker
        personMarker.setLatLng(latlng);
      }

      // Check if we walked into a zone and trigger Spotify!
      checkPersonZone();
    },
    (error) => {
      console.error("GPS Error:", error);
      showToast("Location access denied or unavailable.");
      toggleGPS(); // Automatically toggle off on error
    },
    { enableHighAccuracy: true, maximumAge: 0 }
  );
}

function checkPersonZone() {
  if (!personMarker) return;
  const latlng = personMarker.getLatLng();
  let foundId = null;
  for (const z of zones) {
    if (z.layer && pointInLeafletPolygon(latlng, z.layer)) { foundId = z.id; break; }
  }
  if (foundId !== currentZoneId) {
    currentZoneId = foundId;
    onPersonZoneChange(foundId);
  }
}

function pointInLeafletPolygon(latlng, layer) {
  if (!layer.getBounds().contains(latlng)) return false;
  const verts = layer.getLatLngs()[0];
  let inside = false;
  const x = latlng.lng, y = latlng.lat;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].lng, yi = verts[i].lat;
    const xj = verts[j].lng, yj = verts[j].lat;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// ── ENTERING / LEAVING ZONES: FADES AND GLOW ─────────────────────────────────
// Music fades in over FADE_MS when the person enters a zone and fades out over FADE_MS when
// they leave it; the zone glows (fading in and out with the music) while its music plays.
const FADE_MS = 2000;
let zoneChangeSeq = 0;      // bumped on every zone change, so an older change still fading gives way
let musicZoneId = null;     // zone whose songs are playing, or still fading out
let playerLevel = 100;      // last volume (0-100) given to whichever player is in use
let rampSeq = 0;

function activeTrackType() {
  return queue[queueIndex]?.type === 'soundcloud' ? 'soundcloud' : 'spotify';
}

function setPlayerVolume(type, pct) {
  playerLevel = pct;
  if (type === 'soundcloud') {
    if (scWidget && scReady) scWidget.setVolume(pct);
    return Promise.resolve();
  }
  return spotifyPlayer ? spotifyPlayer.setVolume(pct / 100).catch(() => {}) : Promise.resolve();
}

// Glide the volume from where it is now to `to` over FADE_MS. Another ramp or a manual volume
// change cancels it; resolves true only if it ran to the end.
function rampVolume(type, to) {
  const seq = ++rampSeq;
  const from = playerLevel;
  const start = performance.now();
  return new Promise(resolve => {
    (function step() {
      if (seq !== rampSeq) return resolve(false);
      const t = Math.min(1, (performance.now() - start) / FADE_MS);
      setPlayerVolume(type, from + (to - from) * t);
      if (t < 1) setTimeout(step, 50);
      else resolve(true);
    })();
  });
}

function stopVolumeRamp() { rampSeq++; }

// Fade whatever is playing down to silence, then pause it and put its volume back for next time
async function fadeOutMusic(seq) {
  const spotifyOn = !!spotifyPlayer && currentlyPlaying;
  const scOn = !!scWidget && scReady && scPlaying;
  const type = spotifyOn ? 'spotify' : 'soundcloud';
  if (spotifyOn || scOn) await rampVolume(type, 0);
  if (seq !== zoneChangeSeq) return;   // the person moved again during the fade; that change decides
  if (spotifyPlayer && currentlyPlaying) await spotifyPlayer.pause().catch(() => {});
  if (scWidget && scReady) scWidget.pause();
  if (spotifyOn || scOn) setPlayerVolume(type, queue[queueIndex]?.volume ?? 100);
}

const glowLayers = new Map();   // zone id → blurred outline drawn behind that zone

// The zone the person is in glows while its music is playing; any other glow fades out
function updateZoneGlow() {
  const playing = currentlyPlaying || scPlaying || performance.now() < glowHoldUntil;
  const glowId = playing && musicZoneId != null && musicZoneId === currentZoneId ? musicZoneId : null;
  for (const [id, glow] of glowLayers) {
    const z = getZone(id);
    if (!z?.layer) {   // zone deleted or its shape cleared
      clearTimeout(glow.fadeTimer);
      map.removeLayer(glow);
      glowLayers.delete(id);
      continue;
    }
    glow.setLatLngs(z.layer.getLatLngs());   // follow a redrawn shape
    if (id !== glowId && !glow.fadeTimer) {
      glow.getElement().classList.remove('on');   // CSS fades it out over 2s
      glow.fadeTimer = setTimeout(() => { map.removeLayer(glow); glowLayers.delete(id); }, FADE_MS);
    }
  }
  const z = glowId != null ? getZone(glowId) : null;
  if (!z?.layer) return;
  let glow = glowLayers.get(glowId);
  if (!glow) {
    glow = L.polygon(z.layer.getLatLngs(), {
      className: 'zone-glow', color: z.color, weight: 12, opacity: 0.9, fill: false, interactive: false,
    }).addTo(map);
    glow.bringToBack();   // under the zone, so the zone's own border stays crisp
    glowLayers.set(glowId, glow);
    glow.getElement().getBoundingClientRect();   // lay it out invisible first so the fade-in runs
  }
  clearTimeout(glow.fadeTimer);
  glow.fadeTimer = null;
  glow.getElement().classList.add('on');
}

async function onPersonZoneChange(zoneId) {
<<<<<<< HEAD
  const seq = ++zoneChangeSeq;
=======
  const gen = ++zoneGen;
>>>>>>> 312b56b1fca426800ef113477e8718c43aa81485
  const pulse = document.getElementById('personPulse');
  if (pulse) pulse.classList.toggle('in-zone', !!zoneId);
  pendingSpotifyTrack = null; // a track waiting for the player belongs to the old zone
  fadeInNextTrack = false;
  glowHoldUntil = 0;
  updateZoneGlow();           // the zone just left starts fading its glow straight away

<<<<<<< HEAD
  const z = zoneId ? getZone(zoneId) : null;
  if (!z) {
=======
  if (!zoneId) {
    stopZoneMusic();
>>>>>>> 312b56b1fca426800ef113477e8718c43aa81485
    document.getElementById('npZoneLabel').textContent = 'Outside zones';
  } else {
    showToast(`Entered: ${z.name}`);
    document.getElementById('npZoneLabel').textContent = z.name;
    document.getElementById('nowPlaying').classList.add('show');
    // Stepped back into the zone whose music is still fading out: bring it back up, don't restart it
    if (z.id === musicZoneId && (currentlyPlaying || scPlaying)) {
      rampVolume(activeTrackType(), queue[queueIndex]?.volume ?? 100);
      updateZoneGlow();
      return;
    }
  }

  // The zone just left (if any) fades out before this zone's music fades in
  await fadeOutMusic(seq);
  if (seq !== zoneChangeSeq) return;
  musicZoneId = null;
  if (!z) return;

  if (z.playlist && z.playlist.length > 0) {
<<<<<<< HEAD
    musicZoneId = z.id;
    fadeInNextTrack = true;
    buildQueue(z);
=======
>>>>>>> 312b56b1fca426800ef113477e8718c43aa81485
    try {
      await queuePlayback(async () => {
        if (gen !== zoneGen) return; // the person moved on while an earlier start finished
        buildQueue(z);
        await advanceQueue();
      });
    } catch (e) {
      // This runs un-awaited from the drag/GPS handlers, so surface failures
      console.error('Could not start zone music', e);
      showToast('Could not start music: ' + (e?.message || e), 6000);
    }
  } else {
<<<<<<< HEAD
=======
    stopZoneMusic();
>>>>>>> 312b56b1fca426800ef113477e8718c43aa81485
    document.getElementById('npTrack').textContent = 'No tracks assigned';
    document.getElementById('npArtist').textContent = '';
  }
}

// ── SPOTIFY INIT ON LOAD ──────────────────────────────────────────────────────
async function initSpotify() {
  // Tokens issued to a different Spotify app (SP_CLIENT_ID changed) are rejected,
  // and its refresh token can't be renewed with this ID, so log in again
  if (sessionStorage.getItem('sp_client') !== SP_CLIENT_ID) {
    ['sp_token', 'sp_expiry', 'sp_refresh', 'sp_scope'].forEach(k => sessionStorage.removeItem(k));
  }

  // Check for auth code callback
  const params  = new URLSearchParams(window.location.search);
  const code    = params.get('code');
  const errParam = params.get('error');

  if (errParam) {
    showToast('Spotify auth cancelled');
    history.replaceState({}, '', window.location.pathname);
    return;
  }

  if (code) {
    const ok = await exchangeCode(code);
    if (!ok) { showToast('Token exchange failed'); return; }
  }

  // Check stored token
  const storedToken  = sessionStorage.getItem('sp_token');
  const storedExpiry = parseInt(sessionStorage.getItem('sp_expiry') || '0');

  if (storedToken && Date.now() < storedExpiry) {
    spotifyToken = storedToken;
    document.getElementById('spOverlay').classList.add('hidden');
    // SDK may already be ready; init player
    if (window.Spotify) initPlayer();
    // else onSpotifyWebPlaybackSDKReady will fire and call initPlayer()
    return;
  }

  // Try refresh
  if (sessionStorage.getItem('sp_refresh')) {
    const ok = await refreshToken();
    if (ok) {
      document.getElementById('spOverlay').classList.add('hidden');
      if (window.Spotify) initPlayer();
      return;
    }
  }

  // Show login overlay
  document.getElementById('spOverlay').classList.remove('hidden');
}


function initSoundcloud() {
  const iframe = document.getElementById('scPlayer');
  scWidget = SC.Widget(iframe);
  scWidget.bind(SC.Widget.Events.READY, () => {
    scReady = true;
    console.log('SoundCloud widget ready ✓');
  });
  scWidget.bind(SC.Widget.Events.FINISH, () => {
    scPlaying = false;
    autoAdvance();
    updateZoneGlow();
  });
  scWidget.bind(SC.Widget.Events.PAUSE, () => {
    scPlaying = false;
    updateZoneGlow();
  });
  scWidget.bind(SC.Widget.Events.PLAY, () => {
    // Loaded for a zone the person has already left (see zoneGen)
    if (!mayPlay('soundcloud')) { scWidget.pause(); return; }
    console.log('SC PLAY event fired');
    scPlaying = true;
    if (scFadeInTo != null) {   // first song after entering a zone: fade in from silence
      pendingScVolume = scFadeInTo;   // pausing and resuming later plays at the full level
      scFadeInTo = null;
      setPlayerVolume('soundcloud', 0);
      rampVolume('soundcloud', pendingScVolume);
    } else {
      setPlayerVolume('soundcloud', pendingScVolume);
    }
    updatePlayerUIForSoundcloud();
    updateZoneGlow();
  });
}
// ── BOOT (WRAPPED IN FIREBASE AUTH) ───────────────────────────────────────────
auth.onAuthStateChanged(async (user) => {  // <-- Notice the 'async' here
  if (user) {
    document.getElementById('googleOverlay').classList.add('hidden');
    
    // FETCH DATA BEFORE RENDERING
    await loadZonesFromCloud(user.uid);

    render();
    backfillSpotifyDetails();
    updateChip();
    // Start in Navigate so clicks can't start a zone by accident, except on a brand-new
    // map (no shapes yet), which starts on drawing the selected zone
    setTimeout(() => setMode(zones.some(z => z.layer) ? 'nav' : 'edit'), 600);
    initSpotify(); 
    initSoundcloud();
  } else {
    document.getElementById('googleOverlay').classList.remove('hidden');
    document.getElementById('spOverlay').classList.add('hidden'); 
  }
});
