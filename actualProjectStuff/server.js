require("dotenv").config()

const express = require("express")
const cors = require("cors")

const authRoutes = require("./routes/auth")
const playerRoutes = require("./routes/player")

const app = express()

app.use(cors())
app.use(express.json())
app.use(express.static("public"))

app.use("/auth", authRoutes)
app.use("/player", playerRoutes)

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000")
})