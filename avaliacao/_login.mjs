// Login no Embrapa I/O pelo código enviado por e-mail (Mailpit da Central). Uso: import { login } from './_login.mjs'
const API = 'http://localhost:8090', MAIL = 'http://localhost:8025'
const sleep = ms => new Promise(r => setTimeout(r, ms))
export async function login (email) {
  const r = await fetch(API + '/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
  if (r.status !== 200) throw new Error('pin ' + r.status + ' ' + await r.text())
  let pin = null
  for (let i = 0; i < 20 && !pin; i++) {
    await sleep(500)
    const list = await (await fetch(MAIL + '/api/v1/search?query=' + encodeURIComponent('to:"' + email + '"') + '&limit=1')).json()
    const m = list.messages && list.messages[0]
    const found = m && /^(\d{6}) é seu código/.exec(m.Subject)
    if (found && Date.now() - new Date(m.Created).getTime() < 60000) pin = found[1]
  }
  if (!pin) throw new Error('código não chegou para ' + email)
  const a = await fetch(API + '/authenticate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, pin }) })
  const body = await a.json()
  if (a.status !== 200) throw new Error('authenticate ' + a.status + ' ' + JSON.stringify(body))
  return body
}
export const api = (token) => async (method, path, data) => {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: data === undefined ? undefined : JSON.stringify(data) })
  const t = await r.text(); let j = null; try { j = JSON.parse(t) } catch {}
  return { status: r.status, json: j, text: t }
}
