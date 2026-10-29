import puppeteer from 'puppeteer-core';
const EDGE='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const b=await puppeteer.launch({executablePath:EDGE,headless:true,args:['--no-sandbox','--disable-gpu','--window-size=1400,900']});
const p=await b.newPage(); await p.setViewport({width:1400,height:900});
await p.goto('http://127.0.0.1:8791/?act=dragout-release2',{waitUntil:'load',timeout:30000});
await new Promise(r=>setTimeout(r,9000));
const log=await p.evaluate(()=>window.__errs.slice());
for(const l of log){ if(l.indexOf('reenter-in act=')===0){ const m=l.match(/path=(\[.*?\]) frames/); console.log('PATH=',m?m[1]:'?'); } }
await b.close();
