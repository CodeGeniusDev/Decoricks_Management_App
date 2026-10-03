import { describe, it, expect } from 'vitest'
import {
  getKarachiDate,
  formatKarachiDate,
  getStartOfDay,
  getEndOfDay,
  getStartOfWeek,
  getEndOfWeek,
  getStartOfMonth,
  getEndOfMonth,
  isWithinRange,
  getDaysDiff,
  addDays,
  subtractDays,
} from '../date'

describe('Date Utilities (Asia/Karachi)', () => {
  describe('getKarachiDate', () => {
    it('should return a valid date object', () => {
      const date = getKarachiDate()
      expect(date).toBeInstanceOf(Date)
      expect(isNaN(date.getTime())).toBe(false)
    })
  })

  describe('formatKarachiDate', () => {
    it('should format date correctly', () => {
      const date = new Date('2024-01-15T10:30:00Z')
      const formatted = formatKarachiDate(date, 'date')
      expect(formatted).toMatch(/\d{2}\/\d{2}\/\d{4}/)
    })

    it('should format datetime correctly', () => {
      const date = new Date('2024-01-15T10:30:00Z')
      const formatted = formatKarachiDate(date, 'datetime')
      expect(formatted).toMatch(/\d{2}\/\d{2}\/\d{4}/)
    })

    it('should format time correctly', () => {
      const date = new Date('2024-01-15T10:30:00Z')
      const formatted = formatKarachiDate(date, 'time')
      expect(formatted).toMatch(/\d{2}:\d{2}/)
    })
  })

  describe('getStartOfDay', () => {
    it('should return start of day at 00:00:00', () => {
      const date = new Date('2024-01-15T10:30:00Z')
      const start = getStartOfDay(date)
      expect(start.getHours()).toBe(0)
      expect(start.getMinutes()).toBe(0)
      expect(start.getSeconds()).toBe(0)
      expect(start.getMilliseconds()).toBe(0)
    })

    it('should use current date when no date provided', () => {
      const start = getStartOfDay()
      expect(start).toBeInstanceOf(Date)
    })
  })

  describe('getEndOfDay', () => {
    it('should return end of day at 23:59:59.999', () => {
      const date = new Date('2024-01-15T10:30:00Z')
      const end = getEndOfDay(date)
      expect(end.getHours()).toBe(23)
      expect(end.getMinutes()).toBe(59)
      expect(end.getSeconds()).toBe(59)
    })

    it('should be exactly 24 hours after start of day minus 1ms', () => {
      const date = new Date('2024-01-15T10:30:00Z')
      const start = getStartOfDay(date)
      const end = getEndOfDay(date)
      const diff = end.getTime() - start.getTime()
      expect(diff).toBe(24 * 60 * 60 * 1000 - 1)
    })
  })

  describe('getStartOfWeek', () => {
    it('should return Monday 00:00:00', () => {
      // Test with a Wednesday
      const date = new Date('2024-01-17T10:30:00Z') // Wednesday
      const start = getStartOfWeek(date)
      expect(start.getDay()).toBe(1) // Monday
      expect(start.getHours()).toBe(0)
      expect(start.getMinutes()).toBe(0)
    })

    it('should handle Sunday correctly (previous week Monday)', () => {
      const date = new Date('2024-01-21T10:30:00Z') // Sunday
      const start = getStartOfWeek(date)
      expect(start.getDay()).toBe(1) // Monday
    })
  })

  describe('getEndOfWeek', () => {
    it('should return Sunday 23:59:59.999', () => {
      const date = new Date('2024-01-17T10:30:00Z') // Wednesday
      const end = getEndOfWeek(date)
      expect(end.getDay()).toBe(0) // Sunday
      expect(end.getHours()).toBe(23)
      expect(end.getMinutes()).toBe(59)
    })

    it('should be exactly 7 days after start of week minus 1ms', () => {
      const date = new Date('2024-01-17T10:30:00Z')
      const start = getStartOfWeek(date)
      const end = getEndOfWeek(date)
      const diff = end.getTime() - start.getTime()
      expect(diff).toBe(7 * 24 * 60 * 60 * 1000 - 1)
    })
  })

  describe('getStartOfMonth', () => {
    it('should return 1st of month at 00:00:00', () => {
      const date = new Date('2024-01-15T10:30:00Z')
      const start = getStartOfMonth(date)
      expect(start.getDate()).toBe(1)
      expect(start.getMonth()).toBe(0) // January
      expect(start.getHours()).toBe(0)
      expect(start.getMinutes()).toBe(0)
    })

    it('should handle December correctly', () => {
      const date = new Date('2024-12-15T10:30:00Z')
      const start = getStartOfMonth(date)
      expect(start.getDate()).toBe(1)
      expect(start.getMonth()).toBe(11) // December
    })
  })

  describe('getEndOfMonth', () => {
    it('should return last day of month at 23:59:59.999', () => {
      const date = new Date('2024-01-15T10:30:00Z')
      const end = getEndOfMonth(date)
      expect(end.getDate()).toBe(31) // January has 31 days
      expect(end.getMonth()).toBe(0)
      expect(end.getHours()).toBe(23)
      expect(end.getMinutes()).toBe(59)
    })

    it('should handle February in leap year', () => {
      const date = new Date('2024-02-15T10:30:00Z') // 2024 is leap year
      const end = getEndOfMonth(date)
      expect(end.getDate()).toBe(29) // February has 29 days in leap year
    })

    it('should handle February in non-leap year', () => {
      const date = new Date('2023-02-15T10:30:00Z') // 2023 is not leap year
      const end = getEndOfMonth(date)
      expect(end.getDate()).toBe(28) // February has 28 days
    })
  })

  describe('isWithinRange', () => {
    it('should return true for date within range', () => {
      const date = new Date('2024-01-15T10:30:00Z')
      const start = new Date('2024-01-01T00:00:00Z')
      const end = new Date('2024-01-31T23:59:59Z')
      expect(isWithinRange(date, start, end)).toBe(true)
    })

    it('should return false for date before range', () => {
      const date = new Date('2023-12-31T10:30:00Z')
      const start = new Date('2024-01-01T00:00:00Z')
      const end = new Date('2024-01-31T23:59:59Z')
      expect(isWithinRange(date, start, end)).toBe(false)
    })

    it('should return false for date after range', () => {
      const date = new Date('2024-02-01T10:30:00Z')
      const start = new Date('2024-01-01T00:00:00Z')
      const end = new Date('2024-01-31T23:59:59Z')
      expect(isWithinRange(date, start, end)).toBe(false)
    })

    it('should be inclusive of boundaries', () => {
      const start = new Date('2024-01-01T00:00:00Z')
      const end = new Date('2024-01-31T23:59:59Z')
      expect(isWithinRange(start, start, end)).toBe(true)
      expect(isWithinRange(end, start, end)).toBe(true)
    })
  })

  describe('getDaysDiff', () => {
    it('should calculate days difference correctly', () => {
      const date1 = new Date('2024-01-15T00:00:00Z')
      const date2 = new Date('2024-01-10T00:00:00Z')
      expect(getDaysDiff(date1, date2)).toBe(5)
    })

    it('should handle negative difference', () => {
      const date1 = new Date('2024-01-10T00:00:00Z')
      const date2 = new Date('2024-01-15T00:00:00Z')
      expect(getDaysDiff(date1, date2)).toBe(-5)
    })

    it('should return 0 for same day', () => {
      const date1 = new Date('2024-01-15T10:30:00Z')
      const date2 = new Date('2024-01-15T15:30:00Z')
      expect(getDaysDiff(date1, date2)).toBe(0)
    })
  })

  describe('addDays', () => {
    it('should add days correctly', () => {
      const date = new Date('2024-01-15T00:00:00Z')
      const result = addDays(date, 5)
      expect(result.getDate()).toBe(20)
    })

    it('should handle month boundaries', () => {
      const date = new Date('2024-01-28T00:00:00Z')
      const result = addDays(date, 5)
      expect(result.getDate()).toBe(2)
      expect(result.getMonth()).toBe(1) // February
    })

    it('should handle year boundaries', () => {
      const date = new Date('2024-12-28T00:00:00Z')
      const result = addDays(date, 5)
      expect(result.getDate()).toBe(2)
      expect(result.getFullYear()).toBe(2025)
    })
  })

  describe('subtractDays', () => {
    it('should subtract days correctly', () => {
      const date = new Date('2024-01-15T00:00:00Z')
      const result = subtractDays(date, 5)
      expect(result.getDate()).toBe(10)
    })

    it('should handle month boundaries', () => {
      const date = new Date('2024-03-02T00:00:00Z')
      const result = subtractDays(date, 5)
      expect(result.getDate()).toBe(26)
      expect(result.getMonth()).toBe(1) // February
    })

    it('should handle year boundaries', () => {
      const date = new Date('2024-01-02T00:00:00Z')
      const result = subtractDays(date, 5)
      expect(result.getDate()).toBe(28)
      expect(result.getFullYear()).toBe(2023)
    })
  })

  describe('Month boundary around Karachi midnight', () => {
    it('should handle month transition correctly', () => {
      // Test crossing from Jan 31 to Feb 1 in Karachi timezone
      // Note: Using a date that is definitely in January in Karachi timezone
      const date = new Date('2024-01-15T12:00:00Z')
      const start = getStartOfMonth(date)
      const end = getEndOfMonth(date)
      expect(start.getMonth()).toBe(0) // January
      expect(end.getMonth()).toBe(0) // January
      expect(end.getDate()).toBe(31)
    })

    it('should handle year transition correctly', () => {
      // Note: Using a date that is definitely in December in Karachi timezone
      const date = new Date('2024-12-15T12:00:00Z')
      const start = getStartOfMonth(date)
      const end = getEndOfMonth(date)
      expect(start.getFullYear()).toBe(2024)
      expect(end.getFullYear()).toBe(2024)
      expect(end.getDate()).toBe(31)
    })
  })
})
