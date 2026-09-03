export function addToCart() {}
export function checkout() {}
export function addFromHistory() {}

export const markup = `
  <button onClick={addToCart}>Add</button>
  <form onSubmit={checkout}></form>
`

document.querySelector('#from-history')?.addEventListener('click', addFromHistory)
