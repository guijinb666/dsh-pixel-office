import puppeteer from "puppeteer-core";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const b = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900 });
const resp = await p.goto("http://127.0.0.1:64182", { waitUntil: "networkidle2", timeout: 30000 }).catch((e) => "ERR " + e.message);
console.log("goto:", typeof resp === "string" ? resp : resp && resp.status());
await new Promise((r) => setTimeout(r, 3000));
const info = await p.evaluate(() => ({
  title: document.title,
  url: location.href,
  bodyHead: document.body ? document.body.innerHTML.slice(0, 600) : null,
  ids: Array.from(document.querySelectorAll("[id]")).slice(0, 20).map((e) => e.id),
}));
console.log(JSON.stringify(info, null, 1));
await b.close();
