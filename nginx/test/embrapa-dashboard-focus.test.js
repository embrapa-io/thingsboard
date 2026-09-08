'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { isEnabled, start } = require('../static/embrapa-dashboard-focus')

test('ativa o modo focado somente com o parâmetro da dashboard', () => {
  assert.equal(isEnabled({ search: '?embrapaDashboardFocus=true' }), true)
  assert.equal(isEnabled({ search: '?embedded=true' }), false)
  assert.equal(isEnabled({ search: '?embrapaDashboardFocus=false' }), false)
})

test('adiciona a classe e o CSS de foco ao documento', () => {
  const classes = new Set()
  const elements = new Map()
  const head = { appendChild: element => elements.set(element.id, element) }
  const documentRef = {
    documentElement: { classList: { add: className => classes.add(className) } },
    head: head,
    getElementById: id => elements.get(id) || null,
    createElement: name => ({ name, id: '', textContent: '' })
  }

  assert.equal(start(documentRef, { search: '?embrapaDashboardFocus=true' }), true)
  assert.equal(classes.has('embrapa-dashboard-focus'), true)
  assert.match(elements.get('embrapa-dashboard-focus-style').textContent, /tb-site-sidenav/)
})
