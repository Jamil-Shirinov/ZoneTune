// routes/spotifyAuth.js
const express = require("express");
const axios = require("axios");
const router = express.Router();

const { setAccessToken } = require("../config/spotify");

const REDIRECT_URI = process.env.REDIRECT_URI;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

router.get("/login", (req, res) => {
   const scope = [
     "user-read-playback-state",
     "user-modify-playback-state",
     "user-read-currently-playing",
     "playlist-modify-public",
     "playlist-modify-private"
   ].join(" ");

  console.log("REDIRECT_URI in use:", process.env.REDIRECT_URI);
  const authUrl =
    "https://accounts.spotify.com/authorize" +
    "?response_type=code" +
    `&client_id=${CLIENT_ID}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  console.log("AUTH URL:", authUrl);
  res.redirect(authUrl);
});

router.get("/callback", async (req, res) => {
  try {
    const code = req.query.code;

    const tokenRes = await axios.post(
      "https://accounts.spotify.com/api/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      }
    );

    setAccessToken(tokenRes.data.access_token);
    console.log("Access token set successfully");

    res.redirect("/"); // goes to somewhere eventually
  } catch (err) {
    console.error("Error fetching token:", err.response?.data || err.message);
    res.status(500).send("Authentication failed");
  }
});

module.exports = router;