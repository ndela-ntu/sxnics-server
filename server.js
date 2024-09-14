import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { Server as SocketIOServer } from "socket.io";
import http from "http";
import AudioManager from "./audio_manager.js";

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

const audioManager = new AudioManager(io);

// Setup Socket.IO connection
io.on("connection", (socket) => {
  const currentTrack = audioManager.currentTrack;

  socket.emit("nowPlaying", currentTrack);

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });
});

server.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  await audioManager.startPlayback();
  console.log("Radio started streaming");
});
