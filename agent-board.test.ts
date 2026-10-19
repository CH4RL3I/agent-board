import { test, expect } from 'claude-code/testing'

import { cells } from './hooks/register'

// 16 columns x 5 rows, three 32-bit words per cell, base64 encoded
const BYTES = 16 * 5 * 3 * 4
const b64Length = Math.ceil(BYTES / 3) * 4

test('every sprite renders a full 16x5 cell grid', () => {
  for (const sprite of ['conductor', 'builder', 'scout', 'mate', 'session'] as const) {
    expect(cells(sprite, 0, 'working').length).toBe(b64Length)
  }
})

test('the bob frame and the mood change the pixels', () => {
  expect(cells('builder', 0, 'working')).not.toBe(cells('builder', 1, 'working'))
  expect(cells('builder', 0, 'working')).not.toBe(cells('builder', 0, 'done'))
  expect(cells('builder', 0, 'waiting')).not.toBe(cells('builder', 0, 'working'))
})
