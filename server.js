import express from "express";
import dotenv from "dotenv";
import Radio from "./radio.js"; // Assuming the Radio class is in a file named Radio.js

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const radio = new Radio();

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

app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  await radio.start();
  console.log("Radio started streaming");
});
