import puppeteer from "puppeteer-core";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const b = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage();
await p.setViewport({ width: 420, height: 560 });
const t0 = Date.now();
await p.goto("http://127.0.0.1:8791/", { waitUntil: "domcontentloaded" });
const rows = [];
for (let i = 0; i < 40; i += 1) {
  const s = await p.evaluate(() => {
    const w = window.__pixelOfficeWalk;
    if (typeof w !== "function") return null;
    const o = w();
    const pick = (k) => {
      const wi = o.win[k], a = o.act[k];
      return `${k}:${o.screens[k]}${wi ? " r" + (wi.ready ? 1 : 0) : " -"}|${a ? a.phase : "noact"}${a && a.hidden ? "/H" : ""}`;
    };
    return { q: o.q.join(","), s: ["main", "sub:0", "sub:1", "sub:2"].map(pick).join("  ") };
  });
  if (s) rows.push(`${String(Date.now() - t0).padStart(5)}ms q=[${s.q}] ${s.s}`);
  await new Promise((r) => setTimeout(r, 150));
}
console.log(rows.join("\n"));
await b.close();
