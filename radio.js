import dotenv from "dotenv";
import axios from "axios";
import { Readable } from "stream";
import { PassThrough } from "stream";
import Throttle from "throttle";
import { v4 as uuid } from "uuid";
import ffmpeg from "fluent-ffmpeg";
import mongoose from "mongoose";
import { parseBuffer } from "music-metadata";

dotenv.config();

const GITHUB_API_URL = "https://api.github.com";
const { REPO_OWNER, REPO_NAME, GITHUB_TOKEN } = process.env;

const TARGET_BITRATE = 128;
const BUFFER_SIZE = 1024 * 1024;

// Replace with your MongoDB connection string
const MONGODB_URI =
  "mongodb+srv://Lindelani:16154430@cluster0.jc55flk.mongodb.net/sxnics?retryWrites=true&w=majority&appName=Cluster0";
// For a local MongoDB instance
// or
// const mongoURI = 'your-mongoDB-URI'; // For a cloud MongoDB instance

mongoose
  .connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((error) => console.error("Error connecting to MongoDB:", error));

const trackSchema = new mongoose.Schema({
  filePath: String,
  trackName: String,
  artistName: String,
  trackStarts: String,
  trackEnds: String,
  // Add other fields as necessary
});

const Track = mongoose.model("Track", trackSchema);

class Radio {
  currentTrackIndex = 0;
  clients = [];
  audioPaths = [];
  isPlaying = false;
  nextAudioBuffer = null;

  switchStream = (io) => {
    io.emit("switchStream", "scheduleStream");
  };

  streamAudio = async (io) => {
    if (this.currentTrackIndex >= this.audioPaths.length) {
      this.currentTrackIndex = 0;
    }

    const currentTrack = this.audioPaths[this.currentTrackIndex];
    const filePath = currentTrack.filePath;
    this.currentTrackIndex++;

    try {
      let audioBuffer;
      if (this.nextAudioBuffer) {
        audioBuffer = this.nextAudioBuffer;
        this.nextAudioBuffer = null;
      } else {
        audioBuffer = await this.fetchAudioStreamFromGitHub(filePath);
      }

      // Preload the next audio buffer
      if (this.currentTrackIndex < this.audioPaths.length) {
        const nextFilePath = this.audioPaths[this.currentTrackIndex].filePath;
        this.fetchAudioStreamFromGitHub(nextFilePath)
          .then((buffer) => {
            this.nextAudioBuffer = buffer;
          })
          .catch((error) => {
            console.error("Error preloading next audio:", error);
          });
      }

      // Notify clients about the now playing track
      io.emit("nowPlaying", currentTrack);

      // Create a readable stream from the audio buffer
      const inputStream = new Readable();
      inputStream._read = () => {};
      inputStream.push(audioBuffer);
      inputStream.push(null);

      // Create a PassThrough stream for FFmpeg output
      const outputStream = new PassThrough();

      // Use FFmpeg to convert the bitrate
      ffmpeg(inputStream)
        .audioCodec("libmp3lame")
        .inputOptions([
          "-analyzeduration 0",
          "-probesize 32",
          "-fflags +nobuffer",
          "-flags low_delay",
          "-strict experimental",
        ])
        .outputOptions([
          `-b:a ${TARGET_BITRATE}k`,
          "-acodec libmp3lame",
          "-ac 2",
          "-ar 44100",
          "-preset ultrafast",
          "-tune zerolatency",
        ])
        .format("mp3")
        .pipe(outputStream);

      // Read the converted audio data
      const chunks = [];
      for await (const chunk of outputStream) {
        chunks.push(chunk);
      }
      const convertedBuffer = Buffer.concat(chunks);

      const throttle = new Throttle((TARGET_BITRATE * 1000) / 8); // Convert bitrate from bits/s to bytes/s
      const readableStream = new Readable();
      readableStream._read = () => {};
      readableStream.push(convertedBuffer);
      readableStream.push(null);

      readableStream
        .pipe(throttle)
        .on("data", (chunk) => {
          this.broadcast(chunk);
        })
        .on("end", async () => {
          console.log(`Finished streaming ${filePath}`);
          const metadata =await  parseBuffer(this.nextAudioBuffer);
          const duration = metadata.format.duration;

          const hasSchedule = await checkForScheduledStream(duration);

          if (hasSchedule) {
            this.switchStream(io);
          } else {
            this.streamAudio(io);
          }
        });
    } catch (error) {
      console.error("Error in streamAudio:", error);
    }
  };

  checkForScheduledStream = async (duration) => {
    const tracks = await Track.find();

    const sortedTracks = tracks
      .filter(
        (track) =>
          track.trackStarts !== null &&
          track.trackEnds !== null &&
          Number(track.trackStarts) - Date.now() >= 0
      )
      .sort((a, b) => Number(a.trackStarts) - Number(b.trackStarts));

    // let toReturn = false;
    // if (sortedTracks.length > 0) {
    //   if (Date.now() + duration < sortedTracks.at(0).trackStarts) {
    //     toReturn = false;
    //   }else {
        
    //   }
    // }
  };

  removeClient(id) {
    this.clients = this.clients.filter((client) => client.id !== id);
  }

  addClient = () => {
    const id = uuid();
    const client = new PassThrough();

    this.clients.push({ id, client });
    return { id, client };
  };

  broadcast = (chunk) => {
    this.clients.forEach((value) => {
      value.client.write(chunk);
    });
  };

  fetchAudioFilesFromGitHub = async () => {
    try {
      const tracks = await Track.find();

      this.audioPaths = tracks
        .filter((track) => track.trackStarts == null && track.trackEnds == null)
        .map((track) => ({
          filePath: track.filePath,
          fileName: `${track.artistName} - ${track.trackName}.mp3`,
        }));
    } catch (error) {
      console.error("Error fetching audio files from MongoDB:", error);
    }
  };

  fetchAudioStreamFromGitHub = async (filePath) => {
    const url = `${GITHUB_API_URL}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`;
    try {
      const response = await axios.get(url, {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3.raw",
        },
        responseType: "arraybuffer",
      });
      return response.data;
    } catch (error) {
      console.error("Error fetching audio from GitHub:", error);
      throw error;
    }
  };

  start = async (io) => {
    await this.fetchAudioFilesFromGitHub();
    this.streamAudio(io);
  };
}

export default Radio;
