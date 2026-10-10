const express = require("express")
const axios = require("axios")
const app = express()

app.use(express.json())

//Redo at 11

const token = "BQBIbgtV5R__myzqLTYLRbOYNnvxd4nFMQltC-Q7J4t7W0irdEzFJOpJgA0iGbpboJqelSbD8bxYa8eM3nYmBsc32QpJk0au4p0fKGE_GmnVCveZSLaeM07JlgXP0FEfNjSN1P2dbCE"

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
     -d "grant_type=client_credentials&client_id=c84c3887954a474287977775f490bfed&client_secret=ec519f13424d4f29a9d632dd3c65066c"

Test of Getting Artist
curl "https://api.spotify.com/v1/artists/4Z8W4fKeB5YxbusRsdQVPb" \
     -H "Authorization:Bearer BQBIbgtV5R__myzqLTYLRbOYNnvxd4nFMQltC-Q7J4t7W0irdEzFJOpJgA0iGbpboJqelSbD8bxYa8eM3nYmBsc32QpJk0au4p0fKGE_GmnVCveZSLaeM07JlgXP0FEfNjSN1P2dbCE"
*/

app.listen(3001)


/*
Test of Making Playlist
curl --request POST \
  --url https://api.spotify.com/v1/me/playlists \
  --header 'Authorization: Bearer BQBIbgtV5R__myzqLTYLRbOYNnvxd4nFMQltC-Q7J4t7W0irdEzFJOpJgA0iGbpboJqelSbD8bxYa8eM3nYmBsc32QpJk0au4p0fKGE_GmnVCveZSLaeM07JlgXP0FEfNjSN1P2dbCE' \
  --header 'Content-Type: application/json' \
  --data '{
    "name": "RealSoundtrack Playlist",
    "description": "The playlist for the RealSoundtrack app! Please don't delete.",
    "public": false
}'
*/
