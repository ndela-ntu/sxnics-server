import dotenv from "dotenv";
import axios from "axios";
import { Readable } from "stream";
import { PassThrough } from "stream";
import Throttle from "throttle";
import { v4 as uuid } from "uuid";
import ffmpeg from "fluent-ffmpeg";
import { parseBuffer } from "music-metadata";

dotenv.config();

const GITHUB_API_URL = "https://api.github.com";
const { REPO_OWNER, REPO_NAME, GITHUB_TOKEN } = process.env;

const TARGET_BITRATE = 320;
const BUFFER_SIZE = 1024 * 1024;

class Radio {
  currentTrackIndex = 0;
  clients = [];
  audioPaths = [];
  isPlaying = false;
  nextAudioBuffer = null;

  streamAudio = async () => {
    if (this.currentTrackIndex >= this.audioPaths.length) {
      this.currentTrackIndex = 0;
    }

    const filePath = this.audioPaths[this.currentTrackIndex];
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
        const nextFilePath = this.audioPaths[this.currentTrackIndex];
        this.fetchAudioStreamFromGitHub(nextFilePath)
          .then((buffer) => {
            this.nextAudioBuffer = buffer;
          })
          .catch((error) => {
            console.error("Error preloading next audio:", error);
          });
      }

      // Create a readable stream from the audio buffer
      const inputStream = new Readable();
      inputStream._read = () => {};
      inputStream.push(audioBuffer);
      inputStream.push(null);

      // Create a PassThrough stream for FFmpeg output
      const outputStream = new PassThrough();

      const metadata = await parseBuffer(audioBuffer, {
        mimeType: "audio/mpeg",
      });

      const inputBitrate = metadata.format.bitrate;
      const inputDuration = metadata.format.duration;
      const inputSampleRate = metadata.format.sampleRate;

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

      const throttle = new Throttle(TARGET_BITRATE * 1000 / 8); // Convert bitrate from bits/s to bytes/s
      const readableStream = new Readable();
      readableStream._read = () => {};
      readableStream.push(convertedBuffer);
      readableStream.push(null);

      readableStream
        .pipe(throttle)
        .on("data", (chunk) => {
          this.broadcast(chunk);
        })
        .on("end", () => {
          console.log(`Finished streaming ${filePath}`);
          this.streamAudio();
        });
    } catch (error) {
      console.error("Error in streamAudio:", error);
    }
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
    console.log(`From broadcast: ${chunk.length}, ${this.clients.length}`);
    this.clients.forEach((value) => {
      value.client.write(chunk);
    });
  };

  fetchAudioFilesFromGitHub = async () => {
    const url = `${GITHUB_API_URL}/repos/${REPO_OWNER}/${REPO_NAME}/contents/`;
    try {
      const response = await axios.get(url, {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
        },
      });
      this.audioPaths = response.data
        .filter((file) => file.type === "file" && file.name.endsWith(".mp3"))
        .map((file) => file.path);
    } catch (error) {
      console.error("Error fetching audio files from GitHub:", error);
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

  start = async () => {
    await this.fetchAudioFilesFromGitHub();
    this.streamAudio();
  };
}

export default Radio;
