// Navegador automático para os prints do relatório de ponta a ponta: Edge headless controlado por CDP,
// com a sessão do Embrapa I/O de uma pessoa (login pelo código do Mailpit, via _login.mjs).
//   const nav = await abrir('pesquisador.cerrado@embrapa.br'); await nav.inicio(); await nav.print('01-...'); nav.fechar()
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { login } from './_login.mjs'

export const SITE = 'https://cpcg-237765.taild317c.ts.net'
export const IMG = join(dirname(fileURLToPath(import.meta.url)), 'relatorio-ponta-a-ponta', 'img')
export const sleep = ms => new Promise(r => setTimeout(r, ms))
let proximaPorta = 9360

export async function abrir (email, { largura = 1366, altura = 900 } = {}) {
  mkdirSync(IMG, { recursive: true })
  const auth = await login(email)
  const porta = proximaPorta++
  const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ['--headless=new', '--disable-gpu', `--window-size=${largura},${altura}`, `--remote-debugging-port=${porta}`,
      `--user-data-dir=${mkdtempSync(join(tmpdir(), 'edge-relatorio-'))}`, 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 40; i++) { try { await (await fetch(`http://127.0.0.1:${porta}/json/version`)).json(); break } catch { await sleep(250) } }
  const alvo = await (await fetch(`http://127.0.0.1:${porta}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(alvo.webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r, { once: true }))
  let n = 0; const pendentes = new Map(); const erros = []
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data)
    if (m.id && pendentes.has(m.id)) { pendentes.get(m.id)(m); pendentes.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') erros.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
  })
  const send = (method, params = {}) => new Promise(r => { const i = ++n; pendentes.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  const js = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'erro no navegador')
    return r.result.result.value
  }
  const esperar = async (expression, ms = 20000) => {
    for (let t = 0; t < ms; t += 400) { if (await js(expression)) return true; await sleep(400) }
    return false
  }
  // Instala window.__vm(teste): devolve o primeiro componente Vue para o qual teste(vm) é verdadeiro.
  const instalar = () => js(`window.__vm = teste => { const walk = vm => teste(vm) ? vm : vm.$children.map(walk).find(Boolean); return walk(document.querySelector('#app').__vue__) }; true`)

  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: largura, height: altura, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: SITE + '/' })
  await sleep(3000)
  const usuario = { authenticated: true, name: email, email, picture: '', token: auth.token, embrapa: true }
  await js(`localStorage.setItem('user', ${JSON.stringify(JSON.stringify(usuario))}); true`)

  return {
    email, js, send, esperar, erros, token: auth.token,
    async inicio () {
      await send('Page.navigate', { url: SITE + '/home' })
      const ok = await esperar(`!!document.querySelector('.v-application') && location.pathname === '/home'`)
      await sleep(3500); await instalar()
      return ok
    },
    // Executa uma expressão com `vm` = componente que passa no teste (string JS com `vm`).
    vm: (teste, corpo) => js(`(async () => { const vm = window.__vm(vm => { try { return ${teste} } catch { return false } }); if (!vm) return '__sem_componente__'; ${corpo} })()`),
    async print (nome) {
      await sleep(600)
      const arquivo = join(IMG, nome + '.png')
      writeFileSync(arquivo, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'))
      return arquivo
    },
    fechar () { try { ws.close() } catch {} ; edge.kill() }
  }
}
