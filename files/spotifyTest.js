// Authorization token that must have been created previously. See : https://developer.spotify.com/documentation/web-api/concepts/authorization
const token = 'YOUR_ACCESS_TOKEN';
async function fetchWebApi(endpoint, method, body) {
  const res = await fetch(`https://api.spotify.com/${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    method,
    body:JSON.stringify(body)
  });
  return await res.json();
}

//Ideally, we would edit this in a different function and let people make a list before this
const tracksUri = [
  'spotify:track:5yMYeobBNjomn5lBwUNDVY','spotify:track:6CIQOFf01zQ9qJaqhD6rlH','spotify:track:2GXHNv5YGWkkCbFkWA91oa','spotify:track:50u2y4zgROMZq2db8Qx94B','spotify:track:6SZwj6cjc8JQbkrr8cbIUn'
];

async function createPlaylist(tracksUri){
  const { id: user_id } = await fetchWebApi('v1/me', 'GET')

  const playlist = await fetchWebApi(
    `v1/users/${user_id}/playlists`, 'POST', {
      "name": "My top tracks playlist",
      "description": "Playlist created by the tutorial on developer.spotify.com",
      "public": false
  })

  await fetchWebApi(
    `v1/playlists/${playlist.id}/tracks?uris=${tracksUri.join(',')}`,
    'POST'
  );

  return playlist;
}

const createdPlaylist = await createPlaylist(tracksUri);
console.log(createdPlaylist.name, createdPlaylist.id);
