import { readPNG } from "../tools/png.mjs";
import fs from "node:fs";
const root = "packages/dsh-pixel-office/assets/char";
const dirs = ["subs/final","subs/walk-side","subs/sit-front","subs/sit-side","subs/sit-floor","main/stand-front","main/stand-side","main/final","main/sit-floor"];
for (const d of dirs) {
  const p = root + "/" + d;
  if (!fs.existsSync(p)) { console.log("[" + d + "] MISSING"); continue; }
  const files = fs.readdirSync(p).filter(f => f.endsWith(".png")).sort();
  const out = [];
  for (const f of files) {
    const im = readPNG(p + "/" + f);
    out.push(f.replace(".png","") + "=" + im.w + "x" + im.h);
  }
  console.log("[" + d + "]");
  console.log("  " + out.join("  "));
}
