import express from "express";
import dotenv from "dotenv";
import Radio from "./radio.js";
import cors from "cors";
import { Server as SocketIOServer } from "socket.io";
import http from "http";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
const io = new SocketIOServer(server, {
  cors: {
    origin: "*", // Adjust this as per your CORS policy
    methods: ["GET", "POST"],
  },
});

app.use(cors());

const radio = new Radio();

// Setup Socket.IO connection
io.on("connection", (socket) => {
  console.log("New client connected");
  const currentTrack = radio.audioPaths[radio.currentTrackIndex - 1];

  socket.emit('nowPlaying', currentTrack);

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });
});

app.get("/stream", (req, res) => {
  const { id, client } = radio.addClient();

  res
    .set({
      "Content-Type": "audio/mp3",
      "Transfer-Encoding": "chunked",
    })
    .status(200);

  client.pipe(res);

  req.on("close", () => {
    console.log("Client removed");
    radio.removeClient(id);
  });
});

server.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  await radio.start(io);
  console.log("Radio started streaming");
});
