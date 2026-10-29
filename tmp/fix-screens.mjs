/** 一次性修正 seats.json 里的屏幕矩形（实测值）。 */
import fs from 'node:fs/promises'

const p = 'assets/scene/seats.json'
const d = JSON.parse(await fs.readFile(p, 'utf8'))

d.main.screen = {
  $comment: '双屏深色显示面（实测连通块 x135..203 / y95..121）',
  x: 135,
  y: 95,
  w: 69,
  h: 27,
}

d.subs = d.subs.map((s) => ({
  ...s,
  screen: { x: s.deskCx - 9, y: s.deskTop + 4, w: 17, h: 16 },
}))

const out = JSON.stringify(d, null, 2) + '\n'
await fs.writeFile(p, out)
await fs.writeFile('packages/dsh-pixel-office/assets/scene/seats.json', out)

console.log('main.screen', JSON.stringify(d.main.screen))
console.log('sub:0', JSON.stringify(d.subs[0].screen))
console.log('sub:5', JSON.stringify(d.subs[5].screen))
