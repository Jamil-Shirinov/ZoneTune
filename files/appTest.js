const express = require("express")
const axios = require("axios")
const app = express()

app.use(express.json())

//Redo at 11

const token = "YOUR_ACCESS_TOKEN"

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
/*Make Token
curl -X POST "https://accounts.spotify.com/api/token" \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -d "grant_type=client_credentials&client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET"

Test of Getting Artist
curl "https://api.spotify.com/v1/artists/4Z8W4fKeB5YxbusRsdQVPb" \
     -H "Authorization:Bearer YOUR_ACCESS_TOKEN"
*/

app.listen(3001)


/*
Test of Making Playlist
curl --request POST \
  --url https://api.spotify.com/v1/me/playlists \
  --header 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{
    "name": "RealSoundtrack Playlist",
    "description": "The playlist for the RealSoundtrack app! Please don't delete.",
    "public": false
}'
*/
