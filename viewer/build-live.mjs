/** Inlines the engine bundle into the live arena page. */
import { readFileSync, writeFileSync } from "node:fs";

const template = readFileSync("viewer/live.html", "utf8");
const bundle = readFileSync("viewer/bellum.js", "utf8");

// The bundle is code, not data, so it cannot be escaped - a "<" inside it is a
// less-than operator. Verify instead that it holds no closing script tag.
if (/<\/script/i.test(bundle)) throw new Error("bundle contains a closing script tag");
if (!template.includes("__BUNDLE__")) throw new Error("bundle placeholder not found");

const out = "viewer/arena.html";
writeFileSync(out, template.replace("__BUNDLE__", () => bundle));
console.error(`${out}: ${(readFileSync(out).length / 1024).toFixed(0)} KB`);
