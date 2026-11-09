// Teste do widget "Objetivos do ambiente" no navegador (Edge headless, protocolo DevTools).
//   node 21-navegador.mjs <email> <pasta-das-capturas> responsavel|equipe
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENV = Object.fromEntries(readFileSync(join(HERE, '..', '..', 'backend', '.env'), 'utf8').split(/\r?\n/)
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^"|"$/g, '')]))
const info = JSON.parse(readFileSync(join(HERE, '.18-painel-controle.private.json'), 'utf8'))
const BASE = 'http://127.0.0.1:9095'
const [email, dir, roteiro] = process.argv.slice(2)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const get = async p => (await fetch(BASE + p, { headers: { 'X-Authorization': 'ApiKey ' + ENV.THINGSBOARD_TOKEN } })).json()
const out = []
const check = (id, ok, text) => { out.push(ok); console.log(`${ok ? '✅' : '❌'} ${id} ${text}`) }

const user = (await get('/api/user/users?pageSize=10&page=0&textSearch=' + email)).data.find(u => u.email === email)
const tok = await get(`/api/user/${user.id.id}/token`)
const PORT = 9337
const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', '--disable-gpu', '--window-size=1500,1100', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'edge-21-'))}`, 'about:blank'], { stdio: 'ignore' })
try {
  for (let i = 0; i < 40; i++) { try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break } catch { await sleep(250) } }
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r, { once: true }))
  let n = 0; const pend = new Map()
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
  const send = (method, params = {}) => new Promise(r => { const i = ++n; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const js = async expression => { const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression }); return r.result.result ? r.result.result.value : JSON.stringify(r.result) }
  const shot = async name => { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(dir, name), Buffer.from(s.result.data, 'base64')) }
  const R = `document.querySelector('.eo')`
  const texto = () => js(`${R}.innerText.replace(/\\n+/g, ' | ')`)
  const clicar = async (sel, txt) => { const r = await js(`(() => { const b = [...${R}.querySelectorAll(${JSON.stringify(sel)})].find(x => !${JSON.stringify(txt || '')} || x.innerText.trim().startsWith(${JSON.stringify(txt || '')})); if (!b) return 'não achou'; if (b.disabled) return 'desabilitado'; b.click(); return 'ok' })()`); await sleep(2500); return r }
  const campo = async (f, v) => { await js(`(() => { const el = ${R}.querySelector('[data-f=${f}]'); el.value = ${JSON.stringify(String(v))}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) })()`); await sleep(200) }
  const msg = () => js(`(() => { const m = ${R}.querySelector('.eo-msg'); return m ? m.innerText.replace(/\\n+/g, ' ') : '' })()`)
  const estado = async () => { const g = await (await fetch(`http://localhost:8090/iot/goals?devices=${info.umid.id},${info.ac.id}`, { headers: { Authorization: 'Bearer ' + tok.token } })).json(); return g.goals[0] }

  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${BASE}/dashboards/${info.dashboardId}?accessToken=${tok.token}&refreshToken=${tok.refreshToken}` })
  await sleep(15000)
  console.log('widget:', (await texto()).slice(0, 260))

  if (roteiro === 'responsavel') {
    check('O1', /Manter entre 40 % e 60 %/.test(await texto()) && /Editar/.test(await texto()), 'cartão do objetivo com faixa, equipamentos e botões')

    await clicar('button', '+ Novo objetivo')
    const ed = await texto()
    check('O2', /Novo objetivo/.test(ed) && /O que você quer manter/i.test(ed) && /Equipamentos que ajudam/i.test(ed) && !/Editar/.test(ed), 'editor de novo objetivo abre com as três perguntas')
    await campo('min', 20); await campo('max', 25); await clicar('[data-use]')
    await shot('obj-2-editor.png')
    await clicar('button', 'Cancelar')

    await clicar('button', 'Editar'); await campo('min', 45); await campo('max', 65)
    const pv = await js(`(() => { const p = ${R}.querySelector('.eo-pv'); return p ? p.innerText.replace(/\\n+/g, ' | ') : '' })()`)
    check('O3', /liga abaixo de 45 % e desliga ao chegar a 55 %/.test(pv) && /liga acima de 65 %/.test(pv), 'prévia ao vivo ao editar a faixa: ' + pv)
    await shot('obj-3-editar.png')
    await clicar('button', 'Salvar objetivo'); await sleep(2000)
    const g1 = await estado()
    check('O4', /Objetivo salvo/.test(await msg()) && g1.min === 45 && g1.max === 65, 'faixa 45–65 salva: ' + await msg())

    await js(`${R}.querySelector('[data-act=enabled]').click()`); await sleep(3500)
    const g2 = await estado()
    check('O5', g2.enabled === false && /Automático desligado/.test(await texto()), 'desligar "Automático" deixa os equipamentos no manual')
    await js(`${R}.querySelector('[data-act=enabled]').click()`); await sleep(3500)
    check('O6', (await estado()).enabled === true, 'religar "Automático"')

    await clicar('button', 'Editar'); await campo('min', 40); await campo('max', 60); await clicar('button', 'Salvar objetivo'); await sleep(2000)
    check('O7', (await estado()).min === 40, 'faixa volta para 40–60 (estado da demonstração)')
    await shot('obj-4-responsavel.png')
  }
  if (roteiro === 'equipe') {
    const txt = await texto()
    check('O8', /Somente leitura/.test(txt) && !/Editar|Excluir|Novo objetivo/.test(txt), 'Equipe vê o objetivo com "Somente leitura", sem editar, excluir ou criar')
    check('O9', await js(`${R}.querySelector('[data-act=enabled]').disabled`) === true, 'o botão "Automático" fica desabilitado para a Equipe')
    const r = await js(`fetch('http://localhost:8090/iot/goals', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('jwt_token') }, body: JSON.stringify({ goal: { sensorId: '${info.sensor.id}', key: 'humidity', min: 10, max: 20, actuators: [{ deviceId: '${info.umid.id}', effect: 'raise' }] } }) }).then(r => r.status + ' ' + r.statusText)`)
    check('O10', /^4\d\d/.test(r), 'Equipe chamando a API direto, com o próprio token: ' + r)
    await shot('obj-5-equipe.png')
  }
  ws.close()
} finally { edge.kill() }
console.log(out.filter(Boolean).length + ' PASS de ' + out.length)
