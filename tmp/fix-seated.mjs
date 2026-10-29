/** 修正 seated 落点：实测"坐在桌前、上身越过桌面、尾巴落在椅子上"的最优 y。 */
import fs from 'node:fs/promises'

const p = 'assets/scene/seats.json'
const d = JSON.parse(await fs.readFile(p, 'utf8'))

// 主鱼 sprite 36x51；y = deskTop + 16 = 116，头露在桌面远端、身体盖住屏幕下半、尾巴落在椅子上
d.main.seated = {
  $comment: '角色 sprite 左上角落点。y 经 100/108/116/124 四档扫描实测：116 时坐在椅子上、上身越过桌面、双屏下半被身体遮住。',
  x: d.main.deskCx - 18,
  y: d.main.deskTop + 16,
}

// 副鱼 sprite 26x37；y = deskTop + 8 经 -8/0/+8/+16 四档扫描实测最优
d.subs = d.subs.map((s) => ({
  ...s,
  seated: { x: s.deskCx - 13, y: s.deskTop + 8 },
}))

d.spriteSize = { main: 36, sub: 26 }

const out = JSON.stringify(d, null, 2) + '\n'
await fs.writeFile(p, out)
await fs.writeFile('packages/dsh-pixel-office/assets/scene/seats.json', out)

console.log('main.seated', JSON.stringify(d.main.seated))
console.log('sub:0.seated', JSON.stringify(d.subs[0].seated))
console.log('sub:5.seated', JSON.stringify(d.subs[5].seated))
console.log('sub:11.seated', JSON.stringify(d.subs[11].seated))
