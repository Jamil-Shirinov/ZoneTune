//to review/finish
const express = require("express")
const router = express.Router()

const {
  getCurrentSong,
  skipSong,
  pauseSong,
  playSong,
  addToPlaylist,
  deleteFromPlaylist,
  setupStuff
} = require("../config/spotify")

router.get("/current", async (req, res) => {
  const song = await getCurrentSong()
  res.json(song)
})

router.post("/skip", async (req, res) => {
  await skipSong()
  res.send("Skipped")
})

router.post("/pause", async (req, res) => {
  await pauseSong()
  res.send("Paused")
})
router.post("/play", async (req, res) => {
  await playSong(); // need to implement?
  res.sendStatus(200);
})

router.post("/add", async (req, res) => {
  const { uri } = req.body;
  await addToPlaylist(uri); // need to implement?
  res.sendStatus(200);
})

router.post("/delete", async (req, res) => {
  const { uri } = req.body;
  await deleteFromPlaylist(uri); // need to implement?
  res.sendStatus(200);
})

router.post("/setup-stuff", async (req, res) => {
  try {
    const playlist = await setupStuff();
    res.json({
      message: `Playlist ready: ${playlist.name}`,
      id: playlist.id,
      uri: playlist.uri,
      description: playlist.description
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Failed to setup playlist");
  }
});

module.exports = router

router.get("/current", async (req,res)=>{
  try{
    const song = await getCurrentSong()
    res.json(song)
  } catch(err){
    console.log(err.response?.data || err)
    res.status(500).send("Error")
  }
})