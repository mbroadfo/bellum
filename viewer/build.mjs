/** Inlines a recorded replay into the viewer template. */
import { readFileSync, writeFileSync } from "node:fs";

const [, , replayPath = "replay.json", outPath = "viewer/index.html"] = process.argv;

const template = readFileSync("viewer/template.html", "utf8");
const replay = readFileSync(replayPath, "utf8");

// "<" cannot appear inside a script element without ending it early.
const safe = replay.replace(/</g, "\u003c");
const data = `<script>window.__REPLAY__=${safe};</script>\n`;

const marker = "<script>\n(function () {";
if (!template.includes(marker)) throw new Error("viewer template marker not found");

writeFileSync(outPath, template.replace(marker, data + marker));
console.error(`${outPath}: ${(readFileSync(outPath).length / 1024).toFixed(0)} KB`);
