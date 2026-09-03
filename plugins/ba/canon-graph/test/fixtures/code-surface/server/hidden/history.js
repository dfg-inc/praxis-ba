const router = { post() {} }

// Easy-to-miss nested route — must still be enumerated.
router.post('/orders/from-history', (_req, res) => {
  res.end('replay')
})
