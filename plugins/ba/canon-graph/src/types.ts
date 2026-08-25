export type NodeType = 'vision' | 'fr' | 'nfr' | 'br' | 'cr' | 'wp' | 'bug' | 'epic' | 'goal'
export type Status = 'draft' | 'active' | 'batched' | 'baselined' | 'superseded' | 'retired'
export type Check = { name: string; ok: boolean; reason: string }
export type Verdict = { verdict: 'VERIFY-OK' | 'VERIFY-FAIL'; checks: Check[] }
export type Scope = { kind: 'epic' | 'cr' | 'wp' | 'bug' } | { kind: 'fr' | 'nfr' | 'br'; epic: string }
