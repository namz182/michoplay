import test from "node:test";
import assert from "node:assert/strict";
import { youtubeDownloadErrorText } from "../src/lib/youtube-size.ts";

test("missing files, unreadable locations, and missing locations remain distinct", () => {
  const cases = [
    ["The downloaded MP3 file could not be found.", "The downloaded song is missing from Music/YouTube. Try downloading it again."],
    ["Couldn’t read the downloaded MP3 file path: invalid UTF-8", "MichoPlay couldn't read where the song was saved. Try downloading it again."],
    ["The downloader finished without reporting an MP3 file.", "The download finished without a saved song location. Try downloading it again."],
    ["The downloader did not produce an MP3 file.", "The saved download isn't an MP3 file. Try downloading it again."],
  ];
  for (const [error, expected] of cases) assert.equal(youtubeDownloadErrorText(error), expected);
});

test("specific native errors survive presentation without being generalized", () => {
  const messages = [
    "The downloaded song is missing from Music/YouTube. Try downloading it again.",
    "MichoPlay doesn't have permission to read the downloaded song. Allow access to your Music folder and try again.",
    "The downloaded song's folder is no longer available. Restore the folder or download the song again.",
    "Your Music folder took too long to respond. Check that the drive is connected and try again.",
    "MichoPlay couldn't read the downloaded song. Check that your Music folder is accessible and try again.",
    "The downloaded song is empty. Try downloading it again.",
    "The saved download isn't a song file. Try downloading it again.",
    "MichoPlay couldn't confirm whether the download finished. Try again.",
  ];
  for (const message of messages) assert.equal(youtubeDownloadErrorText(message), message);
});

test("storage failures distinguish full, read-only, and denied access", () => {
  const cases = [
    ["ERROR: No space left on device (os error 28)", "There isn't enough storage to save this song. Free some space and try again."],
    ["ERROR: Read-only file system: /private/music/song.mp3", "Your Music folder is read-only. Allow writing to this folder and try again."],
    ["ERROR: Permission denied: /private/music/song.mp3", "MichoPlay doesn't have permission to save this song. Allow access to your Music folder and try again."],
    ["ERROR: File is being used by another process", "Another app is using the downloaded song. Close it there and try again."],
  ];
  for (const [error, expected] of cases) assert.equal(youtubeDownloadErrorText(error), expected);
});

test("conversion failures explain the stage and distinguish missing encoders", () => {
  const cases = [
    ["ERROR: Postprocessing: Conversion failed!", "The audio downloaded, but conversion to MP3 failed. Try downloading it again."],
    ["ERROR: ffmpeg: Unknown encoder 'libmp3lame'", "MichoPlay's audio tools can't create MP3 files. Update or reinstall the app."],
    ["ERROR: Unknown decoder 'sample_codec'", "This video's audio format isn't supported. Try another version of the song."],
    ["ERROR: ffmpeg: Invalid data found when processing input", "The downloaded audio couldn't be read. Try downloading it again."],
    ["The saved audio couldn't be read.", "The downloaded audio couldn't be read. Try downloading it again."],
  ];
  for (const [error, expected] of cases) assert.equal(youtubeDownloadErrorText(error), expected);
});

test("debug context does not override the actual failure or leak into messages", () => {
  const details = "[debug] ffmpeg, cookies configured; /private/music/song.mp3\nERROR: HTTP Error 403: Forbidden";
  assert.equal(youtubeDownloadErrorText(details), "YouTube blocked this download. Try again.");
  assert.equal(youtubeDownloadErrorText("[debug] ffmpeg, cookies configured\nConnection timed out"), "Couldn't connect to YouTube. Check your internet connection and try again.");
  assert.equal(youtubeDownloadErrorText("The downloaded MP3 file could not be accessed: Permission denied (os error 13)"), "MichoPlay doesn't have permission to read the downloaded song. Allow access to your Music folder and try again.");
});

test("unknown failures do not invent a specific cause or expose technical text", () => {
  const details = "Traceback: /private/music/song.mp3 (unknown internal failure)";
  assert.equal(youtubeDownloadErrorText(details), "Couldn't download this song. Try again.");
  assert.equal(youtubeDownloadErrorText(details, true), "Couldn't download this playlist. Try again.");
});
