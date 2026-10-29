import puppeteer from "puppeteer-core";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const b = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage();
await p.setViewport({ width: 420, height: 560 });
await p.goto("http://127.0.0.1:8791/?act=probe", { waitUntil: "domcontentloaded" });
await p.waitForSelector("[data-po-card]", { timeout: 20000 });
await new Promise(r => setTimeout(r, 12000));
const info = await p.evaluate(() => {
  const cvs = [...document.querySelectorAll("canvas")].map((c, i) => {
    const r = c.getBoundingClientRect();
    return { i, pe: getComputedStyle(c).pointerEvents, z: getComputedStyle(c).zIndex, r: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, parent: c.parentElement && (c.parentElement.getAttribute("data-po-stage") !== null ? "stage" : c.parentElement.tagName) };
  });
  const stage = document.querySelector("[data-po-stage]");
  const cv = stage && stage.querySelector("canvas");
  const r = cv.getBoundingClientRect();
  const d = window.__pixelOfficeDebug(172, 140);
  return { cvs, stage: !!stage, cvRect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, dbg: { hit: d.hit, box: d.box, why: d.why } };
});
console.log(JSON.stringify(info, null, 1));
await b.close();
