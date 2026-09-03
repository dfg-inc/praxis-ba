const app = { get() {}, post() {} }

app.get('/health', (_req, res) => {
  res.end('ok')
})

app.post('/orders', (_req, res) => {
  res.end('created')
})

app.get('/orders/:id', (_req, res) => {
  res.end('one')
})

// app.get('/commented-out', () => {})
