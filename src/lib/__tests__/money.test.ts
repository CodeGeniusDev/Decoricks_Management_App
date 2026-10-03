import { describe, it, expect } from 'vitest'
import {
  pkrToPaisa,
  paisaToPkr,
  formatPaisa,
  formatPkr,
  addPaisa,
  subtractPaisa,
  multiplyPaisa,
  dividePaisa,
  isValidPaisa,
  isValidPkr,
} from '../money'

describe('Money Utilities', () => {
  describe('pkrToPaisa', () => {
    it('should convert PKR to paisa correctly', () => {
      expect(pkrToPaisa(150.50)).toBe(15050)
      expect(pkrToPaisa(0)).toBe(0)
      expect(pkrToPaisa(1)).toBe(100)
      expect(pkrToPaisa(1000)).toBe(100000)
    })

    it('should handle decimal rounding correctly', () => {
      expect(pkrToPaisa(150.555)).toBe(15056) // rounds up
      expect(pkrToPaisa(150.554)).toBe(15055) // rounds down
    })
  })

  describe('paisaToPkr', () => {
    it('should convert paisa to PKR correctly', () => {
      expect(paisaToPkr(15050)).toBe(150.5)
      expect(paisaToPkr(0)).toBe(0)
      expect(paisaToPkr(100)).toBe(1)
      expect(paisaToPkr(100000)).toBe(1000)
    })
  })

  describe('formatPaisa', () => {
    it('should format paisa as PKR string', () => {
      expect(formatPaisa(15050)).toBe('PKR 150.50')
      expect(formatPaisa(0)).toBe('PKR 0.00')
      expect(formatPaisa(100)).toBe('PKR 1.00')
    })
  })

  describe('formatPkr', () => {
    it('should format PKR as string', () => {
      expect(formatPkr(150.5)).toBe('PKR 150.50')
      expect(formatPkr(0)).toBe('PKR 0.00')
      expect(formatPkr(1)).toBe('PKR 1.00')
    })
  })

  describe('addPaisa', () => {
    it('should add paisa amounts correctly', () => {
      expect(addPaisa(100, 50)).toBe(150)
      expect(addPaisa(100, 50, 25)).toBe(175)
      expect(addPaisa(0, 0)).toBe(0)
    })

    it('should handle negative numbers', () => {
      expect(addPaisa(100, -50)).toBe(50)
    })
  })

  describe('subtractPaisa', () => {
    it('should subtract paisa amounts correctly', () => {
      expect(subtractPaisa(100, 50)).toBe(50)
      expect(subtractPaisa(100, 50, 25)).toBe(25)
      expect(subtractPaisa(100, 0)).toBe(100)
    })

    it('should handle multiple subtractions', () => {
      expect(subtractPaisa(100, 25, 25, 25)).toBe(25)
    })

    it('should allow negative results', () => {
      expect(subtractPaisa(50, 100)).toBe(-50)
    })
  })

  describe('multiplyPaisa', () => {
    it('should multiply paisa amounts correctly', () => {
      expect(multiplyPaisa(100, 2)).toBe(200)
      expect(multiplyPaisa(100, 0.5)).toBe(50)
      expect(multiplyPaisa(100, 1.5)).toBe(150)
    })

    it('should handle decimal multiplication with rounding', () => {
      expect(multiplyPaisa(100, 1.555)).toBe(156) // rounds
    })
  })

  describe('dividePaisa', () => {
    it('should divide paisa amounts correctly', () => {
      expect(dividePaisa(100, 2)).toBe(50)
      expect(dividePaisa(100, 4)).toBe(25)
      expect(dividePaisa(150, 3)).toBe(50)
    })

    it('should throw error when dividing by zero', () => {
      expect(() => dividePaisa(100, 0)).toThrow('Division by zero')
    })

    it('should handle decimal division with rounding', () => {
      expect(dividePaisa(100, 3)).toBe(33) // 33.33 rounds to 33
    })
  })

  describe('isValidPaisa', () => {
    it('should validate paisa amounts correctly', () => {
      expect(isValidPaisa(0)).toBe(true)
      expect(isValidPaisa(100)).toBe(true)
      expect(isValidPaisa(100000)).toBe(true)
      expect(isValidPaisa(-1)).toBe(false)
      expect(isValidPaisa(1.5)).toBe(false)
      expect(isValidPaisa(NaN)).toBe(false)
      expect(isValidPaisa(Infinity)).toBe(false)
    })
  })

  describe('isValidPkr', () => {
    it('should validate PKR amounts correctly', () => {
      expect(isValidPkr(0)).toBe(true)
      expect(isValidPkr(150.5)).toBe(true)
      expect(isValidPkr(1000)).toBe(true)
      expect(isValidPkr(-1)).toBe(false)
      expect(isValidPkr(NaN)).toBe(false)
      expect(isValidPkr(Infinity)).toBe(false)
    })
  })
})
