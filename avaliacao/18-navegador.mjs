// Abre o painel do teste 18 como uma pessoa (token via IMPERSONATE do backend), num Edge
// headless pelo protocolo DevTools, e roda ações: inspecionar, clicar, preencher o formulário.
//   node 18-navegador.mjs <email> <saida.png> [acao...]
// Ações: inspecionar | clicar:<índice do widget> | limites:<min>:<max>
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
const [email, out, ...acoes] = process.argv.slice(2)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const get = async p => (await fetch(BASE + p, { headers: { 'X-Authorization': 'ApiKey ' + ENV.THINGSBOARD_TOKEN } })).json()

const user = (await get('/api/user/users?pageSize=10&page=0&textSearch=' + email)).data.find(u => u.email === email)
const tok = await get(`/api/user/${user.id.id}/token`)

const PORT = 9335
const edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', '--disable-gpu', '--window-size=1500,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'edge-18-'))}`, 'about:blank'], { stdio: 'ignore' })
try {
  for (let i = 0; i < 40; i++) { try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break } catch { await sleep(250) } }
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r, { once: true }))
  let n = 0; const pend = new Map()
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
  const send = (method, params = {}) => new Promise(r => { const i = ++n; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const js = async expression => { const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression }); return r.result.result ? r.result.result.value : r.result }
  const mouse = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }) }

  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${BASE}/dashboards/${info.dashboardId}?accessToken=${tok.token}&refreshToken=${tok.refreshToken}` })
  await sleep(14000)

  for (const acao of acoes.length ? acoes : ['inspecionar']) {
    const [nome, a, b] = acao.split(':')
    if (nome === 'inspecionar') {
      console.log(await js(`JSON.stringify([...document.querySelectorAll('tb-widget')].map((w, i) => ({ i,
        texto: w.innerText.replace(/\\s+/g, ' ').slice(0, 110),
        alvos: [...w.querySelectorAll('[role=switch], mat-slide-toggle, .mdc-switch, input, button')].map(e => e.tagName.toLowerCase() + (e.getAttribute('role') ? '[' + e.getAttribute('role') + ']' : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '')).slice(0, 6),
        html: w.querySelector('.tb-widget-content, .tb-widget') ? '' : '' })), null, 1)`))
      console.log('erros:', await js(`JSON.stringify([...document.querySelectorAll('.tb-widget-error, .tb-widget-error-container')].map(e => e.innerText.slice(0,120)))`))
    }
    if (nome === 'clicar') {
      const pos = await js(`(() => { const w = document.querySelectorAll('tb-widget')[${a}];
        const el = w.querySelector('.tb-single-switch-toggle, .tb-toggle, [role=switch], mat-slide-toggle, .mdc-switch') || w.querySelector('.tb-widget-container, .tb-widget');
        const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, alvo: el.tagName + '.' + String(el.className).split(' ')[0] }) })()`)
      const p = JSON.parse(pos); await mouse(p.x, p.y); await sleep(3500)
      console.log('clicou no widget', a, p.alvo, '| aviso na tela:', await js(`[...document.querySelectorAll('.toast, simple-snack-bar, .mat-mdc-snack-bar-label, tb-snack-bar-component, .tb-toast')].map(e => e.innerText).join(' | ').slice(0, 200)`))
    }
    if (nome === 'limites') {
      // digita como uma pessoa: clica no campo, seleciona tudo, escreve; depois clica em Salvar
      const rect = async sel => JSON.parse(await js(`(() => { const w = [...document.querySelectorAll('tb-widget')].find(x => /Salvar/.test(x.innerText));
        const el = ${sel}; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }) })()`))
      for (const [i, v] of [[0, a], [1, b]]) {
        const p = await rect(`w.querySelectorAll('input')[${i}]`)
        await mouse(p.x, p.y)
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
        await send('Input.insertText', { text: String(v) })
        await sleep(300)
      }
      const s = await rect(`[...w.querySelectorAll('button')].find(x => /Salvar/i.test(x.innerText))`)
      await mouse(s.x, s.y)
      const r = 'digitou ' + a + ' e ' + b + ' e clicou em Salvar'
      await sleep(3500)
      console.log('limites:', r, '| aviso na tela:', await js(`[...document.querySelectorAll('.toast, simple-snack-bar, .mat-mdc-snack-bar-label, tb-snack-bar-component, .tb-toast, .tb-multiple-input-widget')].map(e => e.innerText.replace(/\\s+/g,' ')).join(' | ').slice(0, 300)`))
    }
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
  ws.close()
} finally { edge.kill() }
