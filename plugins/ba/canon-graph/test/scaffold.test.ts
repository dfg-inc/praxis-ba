import { describe, it, expect } from 'vitest'
import type { NodeType, Status } from '../src/types'
import * as api from '../src/index'
describe('scaffold', () => {
  it('exports the public barrel', () => { expect(typeof api).toBe('object') })
  it('Status includes the unified enum', () => {
    const s: Status[] = ['draft','active','batched','baselined','superseded','retired']
    expect(s.length).toBe(6)
  })
})
