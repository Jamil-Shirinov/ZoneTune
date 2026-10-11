// ── FIREBASE CONFIGURATION ───────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyCIUl2p-sWCJYtXUPq2oaRWQ2qQoRA_JU4",
  authDomain: "zonetune-f1c8e.firebaseapp.com",
  projectId: "zonetune-f1c8e",
  storageBucket: "zonetune-f1c8e.firebasestorage.app",
  messagingSenderId: "956136154749",
  appId: "1:956136154749:web:3fa11f3a19e3973b203314"
};


const SP_CLIENT_ID = 'f9b4775ad02344929b92935d577c9e17';
const SP_REDIRECT_URI = window.location.origin + '/';
const SP_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
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
let pendingScVolume = 1;


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

function buildQueue(z) {
  queue = z.shuffle ? shuffleArray(z.playlist) : [...z.playlist];
  queueIndex = -1;
}

async function advanceQueue() {
  queueIndex++;
  if (queueIndex >= queue.length) queueIndex = 0;
  await playQueueItem(queue[queueIndex]);
}

async function playQueueItem(track) {
  if (!track) return;
  const vol = (track.volume ?? 100) / 100;
  syncVolumeSlider(track.volume ?? 100);
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
      return;
    }
    pendingSpotifyTrack = null;
    await spotifyPlayer.setVolume(vol);
    await playTrackList([track.uri]);
  } else if (track.type === 'soundcloud') {
    pendingSpotifyTrack = null;
    if (spotifyPlayer && currentlyPlaying) await spotifyPlayer.pause();
    pendingScVolume = track.volume ?? 100;
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
            type: 'spotify',
            volume: t.volume ?? 100,
          };
        }).filter(Boolean);

        return {
          ...cloudZone,
          layer: restoredLayer,
          playlist: validatedPlaylist,
          shuffle: cloudZone.shuffle || false,
          groupId: cloudZone.groupId ?? null
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
let mode = 'draw';
let drawHandler = null;
let drawVertexCount = 0;
let gpsWatchId = null;
let isGpsActive = false;

// ── MAP INIT ─────────────────────────────────────────────────────────────────
const map = L.map('map', {
  center: [37.871994, -122.257884], // Berkeley, CA (lat, lng)
  zoom: 13,
  zoomControl: true,
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
function startDraw() {
  if (drawHandler) { try { drawHandler.disable(); } catch(e){} drawHandler = null; }
  if (!selectedZoneId) { showToast('Select a zone first'); return; }
  const z = getZone(selectedZoneId);
  if (!z) return;

  drawHandler = new L.Draw.Polygon(map, {
    shapeOptions: {
      color: z.color,
      fillColor: z.color,
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
}

// Hint at the Q shortcut in the on-map tooltip once a shape is in progress
L.drawLocal.draw.handlers.polygon.tooltip.cont += '<br>Press Q to start over.';
L.drawLocal.draw.handlers.polygon.tooltip.end  += '<br>Press Q to start over.';

map.on(L.Draw.Event.DRAWVERTEX, e => { drawVertexCount = e.layers.getLayers().length; });

// Last cursor position over the map, so a restarted draw handler can pick it up
let lastMapMouseMove = null;
map.on('mousemove', e => { lastMapMouseMove = e; });
map.on('mouseout', () => { lastMapMouseMove = null; });

// Press Q while drawing to discard the in-progress shape and start over
document.addEventListener('keydown', e => {
  if ((e.key !== 'q' && e.key !== 'Q') || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
  if (mode !== 'draw' || !drawHandler || drawVertexCount === 0) return;
  startDraw();
  // A fresh handler parks its click-catching marker at the map center, so until the mouse
  // moves the map acts like Navigate mode; move it under the cursor straight away
  if (lastMapMouseMove) map.fire('mousemove', lastMapMouseMove);
  showToast('Drawing cleared — start over');
});

map.on(L.Draw.Event.CREATED, function(e) {
  if (!selectedZoneId) return;
  const z = getZone(selectedZoneId);
  if (!z) return;

  // Remove previous layer for this zone
  if (z.layer) drawnItems.removeLayer(z.layer);

  const layer = e.layer;
  applyStyle(layer, z, true);
  drawnItems.addLayer(layer);
  z.layer = layer;
  attachLayerEvents(layer, z);

  saveZones();

  render();

  // Auto-advance to next unmapped zone
  const next = zones.find(z2 => !z2.layer && z2.id !== selectedZoneId);
  if (next) {
    setSelected(next.id);
    if (mode === 'draw') setTimeout(startDraw, 150);
  } else {
    showToast('All zones mapped ✓');
    drawHandler = null;
  }
});

map.on(L.Draw.Event.DRAWSTOP, () => { drawHandler = null; drawVertexCount = 0; });

// ── CANCEL DRAWING WITH "Q" ───────────────────────────────────────────────────
// Mention the shortcut in Leaflet.draw's cursor tooltip so people can find it
const polygonTips = L.drawLocal.draw.handlers.polygon.tooltip;
for (const k of ['start', 'cont', 'end']) polygonTips[k] += ' Press Q to cancel.';

// Throws away the unfinished shape (the zone keeps its previous shape, if it had
// one) and leaves Draw mode. Returns false when nothing was being drawn.
function cancelDrawing() {
  if (!drawHandler || !drawHandler.enabled()) return false;
  setMode('nav'); // disabling the draw handler removes the half-drawn shape
  showToast('Drawing cancelled');
  return true;
}

document.addEventListener('keydown', e => {
  if ((e.key || '').toLowerCase() !== 'q' || e.ctrlKey || e.metaKey || e.altKey) return;
  // Typing a "q" into a zone name, group name or track URL must not cancel
  if (e.target.closest?.('input:not([type="range"]), textarea, select, [contenteditable="true"]')) return;
  if (cancelDrawing()) e.preventDefault();
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
    setSelected(z.id);
    openZonePopup(layer, z);
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
  const musicHtml = z.spotifyUrl
    ? `<div class="popup-music">
         <svg width="12" height="12" viewBox="0 0 24 24" fill="${z.color}"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424a.622.622 0 01-.857.207c-2.348-1.435-5.304-1.76-8.785-.964a.622.622 0 11-.277-1.215c3.809-.87 7.076-.496 9.712 1.115a.623.623 0 01.207.857zm1.223-2.722a.78.78 0 01-1.072.257c-2.687-1.652-6.785-2.13-9.965-1.166a.78.78 0 01-.973-.519.781.781 0 01.52-.972c3.633-1.102 8.147-.568 11.233 1.328a.78.78 0 01.257 1.072zm.105-2.835C14.692 8.95 9.375 8.775 6.297 9.71a.937.937 0 11-.543-1.795c3.528-1.068 9.396-.862 13.105 1.333a.938.938 0 01-.945 1.619z"/></svg>
         Spotify linked
       </div>`
    : `<div class="popup-no-music">No music assigned</div>`;

  const openBtn = z.spotifyUrl
    ? `<a class="popup-btn" href="${esc(z.spotifyUrl)}" target="_blank">Open ↗</a>` : '';

  layer.bindPopup(`
    <div>
      <div class="popup-name" style="color:${z.color}">${esc(z.name)}</div>
      ${musicHtml}
      <div class="popup-actions">
        ${openBtn}
        <button class="popup-btn del" onclick="deleteZone(${z.id})">Delete zone</button>
      </div>
    </div>
  `, { maxWidth: 220, closeButton: true }).openPopup();
}

// ── MODE ─────────────────────────────────────────────────────────────────────
function setMode(m) {
  mode = m;
  document.getElementById('btnDraw').classList.toggle('on', m === 'draw');
  document.getElementById('btnNav').classList.toggle('on', m === 'nav');
  if (m === 'draw') {
    startDraw();
  } else {
    if (drawHandler) { try { drawHandler.disable(); } catch(e){} drawHandler = null; }
  }
}

// ── SELECTION ────────────────────────────────────────────────────────────────
function setSelected(id) {
  selectedZoneId = id;
  zones.forEach(z => {
    if (z.layer) applyStyle(z.layer, z, z.id === id);
  });
  render();
  updateChip();
  if (mode === 'draw') startDraw();
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

  setSelected(z.id);

  saveZones();
  render();
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


function deleteGroup(id) {
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
  const z = getZone(id);
  if (z && z.layer) drawnItems.removeLayer(z.layer);
  zones = zones.filter(z => z.id !== id);
  saveZones();
  if (selectedZoneId === id) selectedZoneId = zones[0]?.id ?? null;
  render();
  updateChip();
}

function detectTrackType(url) {
  if (/^spotify:|open\.spotify\.com/.test(url)) return 'spotify';
  if (/soundcloud\.com\/[^/]+\/[^/]+/.test(url)) return 'soundcloud';
  return null;
}
function extractSoundcloudPermalink(url) {
  // Normalize to just https://soundcloud.com/artist/track
  try {
    const u = new URL(url);
    if (u.hostname === 'soundcloud.com') return url.split('?')[0];
  } catch (e) { }
  return null;
}
async function fetchSoundcloudLabel(permalink) {
  try {
    const res = await fetch(
      `https://soundcloud.com/oembed?url=${encodeURIComponent(permalink)}&format=json`
    );
    const data = await res.json();
    return {
      label: (data.title || permalink).slice(0, 100).replace(/<[^>]*>/g, ''),
      artworkUrl: data.thumbnail_url || null,
      trackId: null,
    };
  } catch (e) {
    return { label: permalink, artworkUrl: null, trackId: null };
  }
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
  if (z.playlist.length >= 100) { showToast('Max 100 tracks per zone'); return; }

  const type = detectTrackType(url.trim());
  if (!type) { showToast('Paste a Spotify or SoundCloud track URL'); return; }

  if (type === 'spotify') {
    const uri = extractSpotifyUri(url.trim());
    if (!uri || !uri.includes(':track:')) { showToast('Please paste a Spotify track URL'); return; }
    const label = await fetchTrackLabel(url.trim(), uri);
    z.playlist.push({ url: url.trim(), uri, label, type: 'spotify', volume: 100 });

  } else if (type === 'soundcloud') {
    const permalink = extractSoundcloudPermalink(url.trim());
    if (!permalink) { showToast('Invalid SoundCloud URL'); return; }
    showToast('Fetching track info…');
    const { label, artworkUrl, trackId } = await fetchSoundcloudLabel(permalink);
    z.playlist.push({ url: permalink, permalink, label, artworkUrl, trackId, type: 'soundcloud', volume: 100 });
  }

  saveZones();
  render();
}

function removeTrack(zoneId, index) {
  const z = getZone(zoneId);
  if (!z) return;
  z.playlist.splice(index, 1);
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
  zones.forEach(z => { if (z.layer) { drawnItems.removeLayer(z.layer); z.layer = null; } });
  saveZones();
  render();
  if (mode === 'draw') startDraw();
}

// Touch drag state (for mobile - press & hold 1s to enter drag mode)
let touchDragState = null;
let touchDragJustEnded = false;
const HOLD_DURATION_MS = 1000;

function appendZoneRow(parent, z) {
  const div = document.createElement('div');
  div.className = 'zone-row' + (z.id === selectedZoneId ? ' selected' : '');
  div.dataset.zoneId = z.id;
  div.innerHTML = `
    <div class="zone-pip zone-drag-handle" style="background:${z.color}" title="Hold to drag" draggable="true"></div>
    <input class="zone-name-inp" value="${esc(z.name)}" maxlength="40" placeholder="Zone name">
    <span class="zone-mapped" title="${z.layer ? 'Mapped' : 'Not drawn yet'}">${z.layer ? '◉' : '○'}</span>
    <button class="del-btn" title="Delete zone">✕</button>
  `;
  const pip = div.querySelector('.zone-drag-handle');
  div.querySelector('.zone-name-inp').addEventListener('input', e => renameZone(z.id, e.target.value));
  div.querySelector('.del-btn').addEventListener('click', e => { e.stopPropagation(); deleteZone(z.id); });

  function handleSelect(e) {
    if (e.target.closest('.del-btn')) return;
    if (e.target.closest('.zone-name-inp')) return;
    if (touchDragState || touchDragJustEnded) return;
    setSelected(z.id);
  }
  div.addEventListener('click', handleSelect);
  div.addEventListener('touchend', handleSelect, { passive: true });

  // Mouse drag (desktop) - pip only
  pip.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', z.id);
    e.dataTransfer.effectAllowed = 'move';
    div.classList.add('zone-dragging');
  });
  pip.addEventListener('dragend', () => div.classList.remove('zone-dragging'));

  // Touch drag (mobile): hold 1s anywhere on row (except input/delete) to enter drag mode
  function touchStart(e) {
    if (e.touches.length !== 1) return;
    if (e.target.closest('.zone-name-inp') || e.target.closest('.del-btn')) return;
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
    const section = document.createElement('div');
    section.className = 'group-section';
    section.innerHTML = `
      <div class="group-header drop-target" data-group-id="${g.id}">
        <span class="group-name">${esc(g.name)}</span>
        <button class="group-del-btn" title="Delete group">✕</button>
      </div>
      <div class="group-zones"></div>
    `;
    section.querySelector('.group-del-btn').addEventListener('click', e => { e.stopPropagation(); deleteGroup(g.id); });
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
    <span class="music-zone-name">${esc(z.name)}</span>
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
      <input class="spotify-inp add-track-inp" placeholder="Paste Spotify or SoundCloud URL…">
      <button class="add-track-btn" data-zone="${z.id}">Add</button>
    </div>
  `;

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
          const vol = +slider.value / 100;
          syncVolumeSlider(+slider.value);
          if (zone.playlist[idx].type === 'spotify' && spotifyPlayer) {
            spotifyPlayer.setVolume(vol);
          } else if (zone.playlist[idx].type === 'soundcloud' && scWidget && scReady) {
            scWidget.setVolume(+slider.value);
          }
        }
      });
        slider.addEventListener('change', () => saveZones());
      });

    ml.appendChild(div);
  });
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
    if (!state) return;
    // Only update UI,  on't advance queue — advanceQueue is called explicitly
    updatePlayerUI(state);
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
  if (track?.type === 'soundcloud') {
    if (scWidget && scReady) scWidget.setVolume(+val);
  } else {
    if (spotifyPlayer) await spotifyPlayer.setVolume(val / 100);
  }
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

  // Show player bar
  document.getElementById('nowPlaying').classList.add('show');

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

  if (state.paused && state.position === 0 && 
    state.track_window?.previous_tracks?.length > 0 &&
    !state.track_window?.current_track) {
  advanceQueue();
}
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
  // In Draw mode Leaflet.draw's invisible cursor marker sits on top of every
  // marker and swallows the mouse, so the person could never be dragged into a
  // zone. Switch to Navigate mode while the person is on the map.
  if (mode === 'draw') setMode('nav');
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
  currentZoneId = null;
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

async function onPersonZoneChange(zoneId) {
  const pulse = document.getElementById('personPulse');
  if (pulse) pulse.classList.toggle('in-zone', !!zoneId);
  pendingSpotifyTrack = null; // a track waiting for the player belongs to the old zone

  if (!zoneId) {
    if (spotifyPlayer && currentlyPlaying) await spotifyPlayer.pause();
    if (scWidget && scReady) scWidget.pause();
    document.getElementById('npZoneLabel').textContent = 'Outside zones';
    return;
  }

  const z = getZone(zoneId);
  if (!z) return;

  showToast(`Entered: ${z.name}`);
  document.getElementById('npZoneLabel').textContent = z.name;
  document.getElementById('nowPlaying').classList.add('show');

  if (z.playlist && z.playlist.length > 0) {
    buildQueue(z);
    try {
      await advanceQueue();
    } catch (e) {
      // This runs un-awaited from the drag/GPS handlers, so surface failures
      console.error('Could not start zone music', e);
      showToast('Could not start music: ' + (e?.message || e), 6000);
    }
  } else {
    if (spotifyPlayer && currentlyPlaying) await spotifyPlayer.pause();
    if (scWidget && scReady) scWidget.pause();
    document.getElementById('npTrack').textContent = 'No tracks assigned';
    document.getElementById('npArtist').textContent = '';
  }
}

// ── SPOTIFY INIT ON LOAD ──────────────────────────────────────────────────────
async function initSpotify() {
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
    advanceQueue();
  });
  scWidget.bind(SC.Widget.Events.PLAY, () => {
    console.log('SC PLAY event fired');
    scWidget.setVolume(pendingScVolume);
    updatePlayerUIForSoundcloud();
  });
}
// ── BOOT (WRAPPED IN FIREBASE AUTH) ───────────────────────────────────────────
auth.onAuthStateChanged(async (user) => {  // <-- Notice the 'async' here
  if (user) {
    document.getElementById('googleOverlay').classList.add('hidden');
    
    // FETCH DATA BEFORE RENDERING
    await loadZonesFromCloud(user.uid);
    
    render();
    updateChip();
    setTimeout(() => setMode('draw'), 600);
    initSpotify(); 
    initSoundcloud();
  } else {
    document.getElementById('googleOverlay').classList.remove('hidden');
    document.getElementById('spOverlay').classList.add('hidden'); 
  }
});
