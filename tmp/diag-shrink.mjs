// 复现"副鱼被拖动后突然缩小"：算每个皮肤在坐下态 vs 抓起态 的实际绘制高度
const skins = [
  ["m1-cat", 37, 43], ["m2-sakura", 37, 45], ["m3-gothic", 37, 45], ["m4-sailor", 40, 43],
  ["m5-sporty", 40, 26], ["m6-witch", 41, 51], ["m7-cafe", 36, 48], ["m8-idol", 41, 40],
];
console.log("皮肤        坐下(skin)  抓起(walk-side)  比例    结果");
for (const [n, sit, walk] of skins) {
  const r = walk / sit;
  const tag = r < 0.9 ? "缩小!!" : (r > 1.1 ? "变大" : "基本一致");
  console.log(n.padEnd(12) + String(sit).padEnd(11) + String(walk).padEnd(17) + r.toFixed(3).padEnd(8) + tag);
}
