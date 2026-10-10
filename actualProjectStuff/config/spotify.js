/*
Make later

getCurrentSong()
skipSong()
playTrack()
pausePlayback()
deleteFromPlaylist()
addToPlaylist()
*/
const axios = require("axios")

let access_token = null
function setAccessToken(token) {
  access_token = token
}
async function getCurrentSong() {
  const res = await axios.get(
    "https://api.spotify.com/v1/me/player/currently-playing",
    {
      headers: { Authorization: `Bearer ${access_token}` }
    }
  )
  return res.data
}
async function skipSong() {
  await axios.post(
    "https://api.spotify.com/v1/me/player/next",
    {},
    { headers: { Authorization: `Bearer ${access_token}` } }
  )
}
async function pauseSong() {
  await axios.put(
    "https://api.spotify.com/v1/me/player/pause",
    {},
    { headers: { Authorization: `Bearer ${access_token}` } }
  )
}

async function playSong() {
  await axios.put(
    "https://api.spotify.com/v1/me/player/play",
    {},
    { headers: { Authorization: `Bearer ${access_token}` } }
  );
}

async function addToPlaylist(trackUri) {
  // You need to specify playlist ID
  const playlistId = getPlaylist();
  await axios.post(
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
    { uris: [trackUri] },
    { headers: { Authorization: `Bearer ${access_token}` } }
  );
}


async function deleteFromPlaylist(trackUri) {
  const playlistId = "YOUR_PLAYLIST_ID";
  await axios.delete(
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
    {
      headers: { Authorization: `Bearer ${access_token}` },
      data: { tracks: [{ uri: trackUri }] }
    }
  );
}

async function getMyPlaylists() { //HELPER FUNCTION DONT ADD
  const res = await axios.get("https://api.spotify.com/v1/me/playlists", {
    headers: { Authorization: `Bearer ${access_token}` }
  });
  return res.data.items; // array of playlists
}


//Fix Later
async function setupStuff() {
  const name = "RealSoundtrack Playlist";
  const description = "The playlist for the RealSoundtrack app! Please don't delete.";

  const userRes = await axios.get("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${access_token}` }
  });
  const userId = userRes.data.id;

  const playlistRes = await axios.post(
    `https://api.spotify.com/v1/users/${userId}/playlists`,
    {
      name: name,
      public: false,          // private playlist
      description: description
    },
    {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json"
      }
    }
  );
  let playlist = playlistsRes.data.items.find(pl => pl.name === name);

  if (!playlist) {
    const playlistRes = await axios.post(
      `https://api.spotify.com/v1/users/${userId}/playlists`,
      {
        name: name,
        public: false,
        description: description
      },
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json"
        }
      }
    );
    playlist = playlistRes.data;
  }
  return playlist;
}

module.exports = {
  setAccessToken,
  getCurrentSong,
  skipSong,
  pauseSong,
  playSong,
  addToPlaylist,
  deleteFromPlaylist,
  setupStuff
}