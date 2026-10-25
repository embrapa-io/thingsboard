// Cria o sysadmin inicial (setup lock da 4.4) e mostra os limites da licença em vigor.
import { ENV, api, login } from './lib.mjs'
const state = await api('GET', '/api/noauth/setup/state')
console.log('estado do setup:', state.json)
if (state.json && state.json.status === 'ACCOUNT_REQUIRED') {
  const r = await api('POST', '/api/noauth/setup/complete', { body: { email: ENV.TB44_SYSADMIN_EMAIL, password: ENV.TB44_SYSADMIN_PASSWORD, loadDemo: false } })
  console.log('setup/complete:', r.status, r.json && r.json.status)
}
const token = await login(ENV.TB44_SYSADMIN_EMAIL, ENV.TB44_SYSADMIN_PASSWORD)
const usage = await api('GET', '/api/admin/licenseUsageInfo', { token })
console.log('licenseUsageInfo:', JSON.stringify(usage.json, null, 1))
