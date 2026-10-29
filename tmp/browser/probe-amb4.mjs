import puppeteer from "puppeteer-core";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const b = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage();
await p.goto("http://127.0.0.1:8791/?act=probe", { waitUntil: "domcontentloaded" });
await p.waitForSelector("[data-po-card]", { timeout: 20000 });
await new Promise(r => setTimeout(r, 7000));
const out = await p.evaluate(() => {
  const snap = window.__pixelOfficeWalk(); // 只为确认钩子在
  return new Promise(async (res) => {
    const s = await (await fetch("/api/pixel-office/state")).json();
    res({ sub1: s.snapshot.subs[1], sub0: s.snapshot.subs[0] });
  });
});
console.log(JSON.stringify(out, null, 2));
await b.close();
