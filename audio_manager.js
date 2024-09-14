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

const TARGET_BITRATE = 128;
const GITHUB_API_URL = "https://api.github.com";
const { REPO_OWNER, REPO_NAME, GITHUB_TOKEN, MONGODB_URI } = process.env;

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
  duration: Number,
  // Add other fields as necessary
});

const Track = mongoose.model("Track", trackSchema);

class AudioManager {
  scheduledTracks = [];
  unscheduledTracks = [];
  playedUnscheduledTracks = new Set();
  currentTrack = null;
  io;
  clients = [];
  currentlyPlaying = null;
  nextScheduledTimeout = null;

  constructor(io) {
    this.io = io;
  }
  
  determineNextTrack = (currentTrack) => {
    const now = new Date();
    let nextTrack;

    if (currentTrack.trackEnds) {
      // If the current track is scheduled, look for the next scheduled track
      nextTrack = this.scheduledTracks.find(track => track.trackStarts > currentTrack.trackEnds);
    }

    if (!nextTrack) {
      // If no scheduled track is found, or if the current track is unscheduled
      const availableTracks = this.unscheduledTracks.filter(
        track => !this.playedUnscheduledTracks.has(track.id)
      );

      if (availableTracks.length > 0) {
        nextTrack = availableTracks[Math.floor(Math.random() * availableTracks.length)];
      } else {
        // If all unscheduled tracks have been played, reset and choose a random one
        this.resetUnscheduledTracks();
        nextTrack = this.unscheduledTracks[Math.floor(Math.random() * this.unscheduledTracks.length)];
      }
    }

    return nextTrack;
  };

  streamAudio = async (currentTrack) => {
    try {
      const nextTrack = this.determineNextTrack(currentTrack);
      const currentAudioBuffer = await this.fetchAudioStreamFromGitHub(currentTrack.filePath);
      const nextAudioBuffer = nextTrack ? await this.fetchAudioStreamFromGitHub(nextTrack.filePath) : null;

      const readableStream = await this.convertAudioBuffer(currentAudioBuffer, nextAudioBuffer, currentTrack, nextTrack);
      const throttle = new Throttle((TARGET_BITRATE * 1000) / 8);

      readableStream
        .pipe(throttle)
        .on("data", (chunk) => {
          this.io.emit("audioChunk", chunk);
        })
        .on("end", async () => {
          this.onTrackEnd(currentTrack.trackStarts !== null, nextTrack)
        });
    } catch (error) {
      console.error("Error in streamAudio:", error);
    }
  };

  convertAudioBuffer = async (currentAudioBuffer, nextAudioBuffer, currentTrack, nextTrack) => {
    try {
      const currentMetadata = await parseBuffer(currentAudioBuffer, {
        mimeType: "audio/mp3",
      });
      const nextMetadata = nextAudioBuffer ? await parseBuffer(nextAudioBuffer, {
        mimeType: "audio/mp3",
      }) : null;

      const currentAudioDuration = currentMetadata.format.duration;
      const fadeDuration = 5;

      const currentInputStream = new Readable();
      currentInputStream._read = () => {};
      currentInputStream.push(currentAudioBuffer);
      currentInputStream.push(null);

      const nextInputStream = new Readable();
      if (nextAudioBuffer) {
        nextInputStream._read = () => {};
        nextInputStream.push(nextAudioBuffer);
        nextInputStream.push(null);
      }

      const outputStream = new PassThrough();

      const ffmpegCommand = ffmpeg(currentInputStream)
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
        ]);

      if (nextAudioBuffer) {
        ffmpegCommand
          .input(nextInputStream)
          .complexFilter([
            `[0:a]afade=t=out:st=${currentAudioDuration - fadeDuration}:d=${fadeDuration}[a0]`,
            `[1:a]afade=t=in:st=0:d=${fadeDuration},adelay=${(currentAudioDuration - fadeDuration) * 1000}|${(currentAudioDuration - fadeDuration) * 1000}[a1]`,
            `[a0][a1]amix=inputs=2:duration=longest`
          ]);
      } else {
        ffmpegCommand.audioFilter(`afade=t=out:st=${currentAudioDuration - fadeDuration}:d=${fadeDuration}`);
      }

      ffmpegCommand
        .format("mp3")
        .pipe(outputStream);

      const chunks = [];
      for await (const chunk of outputStream) {
        chunks.push(chunk);
      }
      const convertedBuffer = Buffer.concat(chunks);

      const readableStream = new Readable();
      readableStream._read = () => {};
      readableStream.push(convertedBuffer);
      readableStream.push(null);

      return readableStream;
    } catch (error) {
      console.error(error);
    }
  };

  fetchScheduledAudioFiles = async () => {
    const tracks = await Track.find({ trackStarts: { $ne: null } });

    this.scheduledTracks = tracks
      .sort((a, b) => new Date(a.trackStarts) - new Date(b.trackStarts))
      .map((track) => ({
        id: track._id.toString(),
        filePath: track.filePath,
        fileName: `${track.artistName} - ${track.trackName}.mp3`,
        trackStarts: new Date(Number(track.trackStarts)),
        trackEnds: new Date(Number(track.trackEnds)),
        duration: track.duration,
      }));
  };

  fetchUnscheduledAudioFiles = async () => {
    const tracks = await Track.find({ trackStarts: null });

    this.unscheduledTracks = tracks.map((track) => ({
      id: track._id.toString(),
      filePath: track.filePath,
      fileName: `${track.artistName} - ${track.trackName}.mp3`,
      duration: track.duration,
    }));
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

  scheduleNextTrack = async () => {
    if (this.currentlyPlaying) {
      console.log("A track is already playing. Waiting for it to finish.");
      return;
    }

    const now = new Date();
    let nextScheduledTrack = this.scheduledTracks.find(
      (track) => track.trackStarts > now
    );

    if (nextScheduledTrack) {
      const timeUntilNextScheduled =
        nextScheduledTrack.trackStarts.getTime() - now.getTime();

      if (timeUntilNextScheduled <= 0) {
        await this.playScheduledTrack(nextScheduledTrack);
      } else {
        const unscheduledTrack = this.findSuitableUnscheduledTrack(
          timeUntilNextScheduled
        );
        if (unscheduledTrack) {
          await this.playUnscheduledTrack(unscheduledTrack);
        } else {
          this.waitForScheduledTrack(nextScheduledTrack);
        }
      }
    } else {
      await this.playNextUnscheduledOrSchedule();
    }

    // Prefetch the next track
    this.prefetchNextTrack();
  };

  prefetchNextTrack = async () => {
    const now = new Date();
    let nextTrack = this.scheduledTracks.find(
      (track) => track.trackStarts > now
    );

    if (!nextTrack) {
      // If no scheduled track, choose an unscheduled one
      const availableTracks = this.unscheduledTracks.filter(
        (t) => !this.playedUnscheduledTracks.has(t.id)
      );
      if (availableTracks.length > 0) {
        nextTrack =
          availableTracks[Math.floor(Math.random() * availableTracks.length)];
      }
    }

    if (nextTrack && nextTrack !== this.prefetchedTrack) {
      console.log(`Prefetching next track: ${nextTrack.fileName}`);
      try {
        const audioBuffer = await this.fetchAudioStreamFromGitHub(
          nextTrack.filePath
        );
        this.prefetchedTrack = { ...nextTrack, audioBuffer };
      } catch (error) {
        console.error(`Error prefetching track ${nextTrack.fileName}:`, error);
        this.prefetchedTrack = null;
      }
    }
  };

  findSuitableUnscheduledTrack = (availableTime) => {
    const BUFFER_TIME = 5000; // 5 seconds buffer
    return this.unscheduledTracks.find(
      (track) =>
        track.duration * 1000 < availableTime - BUFFER_TIME &&
        !this.playedUnscheduledTracks.has(track.id)
    );
  };

  playNextUnscheduledOrSchedule = () => {
    const availableTracks = this.unscheduledTracks.filter(
      (t) => !this.playedUnscheduledTracks.has(t.id)
    );
    if (availableTracks.length > 0) {
      const track =
        availableTracks[Math.floor(Math.random() * availableTracks.length)];
      this.playUnscheduledTrack(track);
    } else {
      console.log(
        "All unscheduled tracks have been played. Resetting the playlist."
      );
      this.resetUnscheduledTracks();
      this.scheduleNextTrack();
    }
  };

  waitForScheduledTrack = (track) => {
    const now = new Date();
    const timeUntilTrack = track.trackStarts.getTime() - now.getTime();
    console.log(
      `Waiting ${timeUntilTrack}ms for scheduled track: ${track.fileName}`
    );

    if (this.nextScheduledTimeout) {
      clearTimeout(this.nextScheduledTimeout);
    }

    this.nextScheduledTimeout = setTimeout(async () => {
      if (this.currentlyPlaying) {
        // Fade out the current track before playing the scheduled one
        await this.fadeOutCurrentTrack();
      }
      await this.playScheduledTrack(track);
    }, timeUntilTrack);
  };

  fadeOutCurrentTrack = async () => {
    console.log(`Fading out current track: ${this.currentlyPlaying.fileName}`);

    // Adjust the volume gradually to create a fade-out effect
    for (let i = 100; i >= 0; i -= 10) {
      const throttle = new Throttle((TARGET_BITRATE * 1000 * i) / 800);
      this.clients.forEach((value) => {
        throttle.pipe(value.client, { end: i === 0 });
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.onTrackEnd(true);
  };

  playScheduledTrack = async (track) => {
    if (this.currentlyPlaying) {
      console.log(
        `Cannot play scheduled track: ${track.fileName}. Another track is already playing.`
      );
      return;
    }

    console.log(`Playing scheduled track: ${track.fileName}`);
    this.currentlyPlaying = track;

    let audioBuffer;
    if (this.prefetchedTrack && this.prefetchedTrack.id === track.id) {
      audioBuffer = this.prefetchedTrack.audioBuffer;
      this.prefetchedTrack = null;
    } else {
      audioBuffer = await this.fetchAudioStreamFromGitHub(track.filePath);
    }

    await this.streamAudio(audioBuffer, true, track);
  };

  playUnscheduledTrack = async (track) => {
    if (this.currentlyPlaying) {
      console.log(
        `Cannot play unscheduled track: ${track.fileName}. Another track is already playing.`
      );
      return;
    }

    console.log(`Playing unscheduled track: ${track.fileName}`);
    this.currentlyPlaying = track;

    let audioBuffer;
    if (this.prefetchedTrack && this.prefetchedTrack.id === track.id) {
      audioBuffer = this.prefetchedTrack.audioBuffer;
      this.prefetchedTrack = null;
    } else {
      audioBuffer = await this.fetchAudioStreamFromGitHub(track.filePath);
    }

    this.playedUnscheduledTracks.add(track.id);
    await this.streamAudio(audioBuffer, false, track);
  };

  onTrackEnd = async (wasScheduled) => {
    console.log(`Track ended. Was scheduled: ${wasScheduled}`);
    this.currentlyPlaying = null;
    await this.scheduleNextTrack();
  };

  startPlayback = async () => {
    await this.fetchScheduledAudioFiles();
    await this.fetchUnscheduledAudioFiles();
    await this.scheduleNextTrack();
  };

  stopPlayback = () => {
    if (this.nextScheduledTimeout) {
      clearTimeout(this.nextScheduledTimeout);
    }
    this.prefetchedTrack = null;
    // TODO: Implement any necessary cleanup
  };

  resetUnscheduledTracks = () => {
    this.playedUnscheduledTracks.clear();
    console.log(
      "Unscheduled tracks have been reset. All tracks are now available to play again."
    );
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
}

export default AudioManager;
