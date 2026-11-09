// Simulador do teste 18: sala com sensor de umidade, umidificador e ar-condicionado.
// Os atuadores leem o atributo compartilhado "ligar" e confirmam em "estado" (atributo de cliente).
// A umidade sobe com o umidificador ligado e cai com o ar-condicionado ligado.
//   node 18-simulador.mjs            (roda até ser encerrado)
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const info = JSON.parse(readFileSync(join(HERE, '.18-painel-controle.private.json'), 'utf8'))
const BASE = process.env.TB_CENTRAL_URL || 'http://127.0.0.1:9095'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const post = (token, path, body) => fetch(`${BASE}/api/v1/${token}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
const shared = async token => { try { const r = await fetch(`${BASE}/api/v1/${token}/attributes?sharedKeys=ligar`); const j = await r.json(); return j.shared && j.shared.ligar } catch { return undefined } }

const atuadores = { umid: { token: info.umid.token, estado: false }, ac: { token: info.ac.token, estado: false } }
for (const a of Object.values(atuadores)) await post(a.token, 'attributes', { estado: false })
let h = 50

for (let tick = 0; ; tick++) {
  for (const [nome, a] of Object.entries(atuadores)) {
    const pedido = await shared(a.token)
    if (typeof pedido === 'boolean' && pedido !== a.estado) {
      a.estado = pedido
      await post(a.token, 'attributes', { estado: pedido })
      console.log(new Date().toLocaleTimeString(), nome, '→', pedido ? 'LIGADO' : 'desligado')
    }
  }
  if (tick % 3 === 0) {
    h += (atuadores.umid.estado ? 1.2 : 0) - (atuadores.ac.estado ? 1.6 : 0) - 0.15 + (Math.random() - 0.5) * 0.4
    h = Math.max(20, Math.min(90, Math.round(h * 10) / 10))
    await post(info.sensor.token, 'telemetry', { humidity: h })
  }
  await sleep(2000)
}
