// Teste do widget "Regras do equipamento" no navegador (Edge headless, protocolo DevTools).
//   node 20-navegador.mjs <email> <pasta-das-capturas> <roteiro>
// Roteiros: responsavel | equipe
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
const check = (id, ok, text) => { out.push(ok); console.log(`${ok === null ? 'ℹ️ ' : ok ? '✅' : '❌'} ${id} ${text}`) }

const user = (await get('/api/user/users?pageSize=10&page=0&textSearch=' + email)).data.find(u => u.email === email)
const tok = await get(`/api/user/${user.id.id}/token`)
const PORT = 9336
const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', '--disable-gpu', '--window-size=1500,1100', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'edge-20-'))}`, 'about:blank'], { stdio: 'ignore' })
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
  // utilitários dentro da página, todos sobre o widget de regras
  const W = `const R = document.querySelector('.er-root'); const devs = [...R.querySelectorAll('.er-dev')];`
  const texto = () => js(`(() => { ${W} return R.innerText.replace(/\\n+/g, ' | ') })()`)
  const clicar = async (dev, rotulo) => { const r = await js(`(() => { ${W} const b = [...devs[${dev}].querySelectorAll('button')].find(x => x.innerText.trim().startsWith(${JSON.stringify(rotulo)})); if (!b) return 'sem botão'; if (b.disabled) return 'desabilitado'; b.click(); return 'ok' })()`); await sleep(2500); return r }
  const campo = async (dev, f, v) => { await js(`(() => { ${W} const el = devs[${dev}].querySelector('[data-f=${f}]'); el.value = ${JSON.stringify(String(v))}; el.dispatchEvent(new Event('change', { bubbles: true })) })()`); await sleep(150) }
  const preencher = async (dev, r) => { await campo(dev, 'sensorId', info.sensor.id); await campo(dev, 'key', 'humidity'); for (const k of ['op', 'value', 'action', 'revert']) await campo(dev, k, r[k]) }
  const msg = () => js(`(() => { const m = document.querySelector('.er-msg'); return m ? m.innerText.replace(/\\n+/g, ' ') : '' })()`)
  const preview = dev => js(`(() => { ${W} const p = devs[${dev}].querySelector('.er-preview'); return p ? p.innerText : '' })()`)

  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${BASE}/dashboards/${info.dashboardId}?accessToken=${tok.token}&refreshToken=${tok.refreshToken}` })
  await sleep(15000)
  console.log('widget:', await texto())

  if (roteiro === 'responsavel') {
    // dispositivo 0 = Umidificador, 1 = Ar-condicionado (ordem das fontes do widget)
    check('W1', /Umidificador/.test(await texto()) && !/Somente leitura/.test(await texto()), 'Responsável vê os dois equipamentos, sem "Somente leitura"')

    await clicar(1, '+ Nova regra'); await preencher(1, { op: 'gt', value: 60, action: 'on', revert: 70 }); await clicar(1, 'Ver prévia')
    check('W2', /retorno precisa ser menor que 60/.test(await msg()), 'retorno do lado errado é recusado com explicação: ' + await msg())

    await campo(1, 'revert', 55); await clicar(1, 'Ver prévia')
    const p = await preview(1)
    check('W3', /acima de 60, ligar este equipamento\. Desligar quando ficar abaixo de 55/.test(p), 'prévia em português: ' + p)
    await clicar(1, 'Salvar regra'); await sleep(1500)
    check('W4', /Regra salva/.test(await msg()), 'Ar-condicionado: regra salva → ' + await msg())

    await clicar(0, '+ Nova regra'); await preencher(0, { op: 'lt', value: 40, action: 'on', revert: 60 }); await clicar(0, 'Ver prévia'); await clicar(0, 'Salvar regra'); await sleep(1500)
    check('W5', /Regra salva/.test(await msg()), 'Umidificador: "abaixo de 40 liga, acima de 60 desliga" salva → ' + await msg())
    await clicar(0, '+ Nova regra'); await preencher(0, { op: 'gt', value: 60, action: 'off', revert: '' }); await clicar(0, 'Ver prévia'); await clicar(0, 'Salvar regra'); await sleep(1500)
    check('W6', /Regra salva/.test(await msg()), 'Umidificador: segunda regra "acima de 60 desliga" salva')
    await shot('regras-1-responsavel.png')

    await clicar(0, 'Pausar'); check('W7', /Regra pausada/.test(await msg()), 'pausar a regra 1 do umidificador')
    await clicar(0, 'Retomar'); check('W8', /Regra retomada/.test(await msg()), 'retomar')
    await clicar(0, 'Excluir'); await clicar(0, 'Confirmar exclusão')
    check('W9', /Regra excluída/.test(await msg()), 'excluir (com confirmação) a última regra do umidificador → ' + (await texto()).slice(0, 160))
    await shot('regras-2-responsavel.png')
  }

  if (roteiro === 'equipe') {
    const txt = await texto()
    check('W10', /Somente leitura/.test(txt) && !/\+ Nova regra/.test(txt) && !/Pausar|Excluir/.test(txt), 'Equipe vê as regras, com "Somente leitura" e sem botões de alteração')
    const r = await js(`fetch('http://localhost:8090/iot/rules/${info.ac.id}', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('jwt_token') }, body: JSON.stringify({ rule: { sensorId: '${info.sensor.id}', key: 'humidity', op: 'gt', value: 10, action: 'on' } }) }).then(r => r.status + ' ' + r.statusText).catch(e => 'erro ' + e.message)`)
    check('W11', /^403/.test(r), 'Equipe chamando a API direto do navegador, com o próprio token, para criar regra: ' + r)
    await shot('regras-3-equipe.png')
  }
  ws.close()
} finally { edge.kill() }
console.log(out.filter(x => x === true).length + ' PASS de ' + out.filter(x => x !== null).length)
