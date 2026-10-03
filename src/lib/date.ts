/**
 * Date utilities for Asia/Karachi timezone
 */

const TIMEZONE = 'Asia/Karachi'

/**
 * Get current date in Karachi timezone
 * @returns Date object in Karachi timezone
 */
export function getKarachiDate(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }))
}

/**
 * Format date to string in Karachi timezone
 * @param date - Date to format
 * @param format - Format type ('date', 'datetime', 'time')
 * @returns Formatted string
 */
export function formatKarachiDate(
  date: Date,
  format: 'date' | 'datetime' | 'time' = 'date'
): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: TIMEZONE,
  }

  if (format === 'date') {
    options.year = 'numeric'
    options.month = '2-digit'
    options.day = '2-digit'
  } else if (format === 'datetime') {
    options.year = 'numeric'
    options.month = '2-digit'
    options.day = '2-digit'
    options.hour = '2-digit'
    options.minute = '2-digit'
  } else if (format === 'time') {
    options.hour = '2-digit'
    options.minute = '2-digit'
  }

  return new Intl.DateTimeFormat('en-PK', options).format(date)
}

/**
 * Get start of day in Karachi timezone
 * @param date - Date to get start of day for (defaults to today)
 * @returns Date object at 00:00:00 in Karachi timezone
 */
export function getStartOfDay(date?: Date): Date {
  const targetDate = date || getKarachiDate()
  const year = parseInt(
    targetDate.toLocaleString('en-US', { timeZone: TIMEZONE, year: 'numeric' })
  )
  const month = parseInt(
    targetDate.toLocaleString('en-US', { timeZone: TIMEZONE, month: 'numeric' })
  ) - 1
  const day = parseInt(
    targetDate.toLocaleString('en-US', { timeZone: TIMEZONE, day: 'numeric' })
  )

  return new Date(year, month, day, 0, 0, 0)
}

/**
 * Get end of day in Karachi timezone
 * @param date - Date to get end of day for (defaults to today)
 * @returns Date object at 23:59:59.999 in Karachi timezone
 */
export function getEndOfDay(date?: Date): Date {
  const start = getStartOfDay(date)
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1)
}

/**
 * Get start of week in Karachi timezone (Monday)
 * @param date - Date to get start of week for (defaults to today)
 * @returns Date object at Monday 00:00:00 in Karachi timezone
 */
export function getStartOfWeek(date?: Date): Date {
  const targetDate = date || getKarachiDate()
  const start = getStartOfDay(targetDate)
  const day = start.getDay()
  const diff = start.getDate() - day + (day === 0 ? -6 : 1) // Adjust for Monday start
  return new Date(start.setDate(diff))
}

/**
 * Get end of week in Karachi timezone (Sunday)
 * @param date - Date to get end of week for (defaults to today)
 * @returns Date object at Sunday 23:59:59.999 in Karachi timezone
 */
export function getEndOfWeek(date?: Date): Date {
  const start = getStartOfWeek(date)
  return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000 - 1)
}

/**
 * Get start of month in Karachi timezone
 * @param date - Date to get start of month for (defaults to today)
 * @returns Date object at 1st 00:00:00 in Karachi timezone
 */
export function getStartOfMonth(date?: Date): Date {
  const targetDate = date || getKarachiDate()
  const year = parseInt(
    targetDate.toLocaleString('en-US', { timeZone: TIMEZONE, year: 'numeric' })
  )
  const month = parseInt(
    targetDate.toLocaleString('en-US', { timeZone: TIMEZONE, month: 'numeric' })
  ) - 1

  return new Date(year, month, 1, 0, 0, 0)
}

/**
 * Get end of month in Karachi timezone
 * @param date - Date to get end of month for (defaults to today)
 * @returns Date object at last day 23:59:59.999 in Karachi timezone
 */
export function getEndOfMonth(date?: Date): Date {
  const start = getStartOfMonth(date)
  const nextMonth = new Date(start)
  nextMonth.setMonth(nextMonth.getMonth() + 1)
  return new Date(nextMonth.getTime() - 1)
}

/**
 * Check if date is within range in Karachi timezone
 * @param date - Date to check
 * @param start - Start of range
 * @param end - End of range
 * @returns True if date is within range
 */
export function isWithinRange(date: Date, start: Date, end: Date): boolean {
  return date >= start && date <= end
}

/**
 * Get difference in days between two dates in Karachi timezone
 * @param date1 - First date
 * @param date2 - Second date
 * @returns Difference in days
 */
export function getDaysDiff(date1: Date, date2: Date): number {
  const oneDay = 24 * 60 * 60 * 1000
  const diff = Math.round((date1.getTime() - date2.getTime()) / oneDay)
  // Handle -0 case
  return diff === 0 ? 0 : diff
}

/**
 * Add days to date in Karachi timezone
 * @param date - Date to add to
 * @param days - Number of days to add
 * @returns New date
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

/**
 * Subtract days from date in Karachi timezone
 * @param date - Date to subtract from
 * @param days - Number of days to subtract
 * @returns New date
 */
export function subtractDays(date: Date, days: number): Date {
  return addDays(date, -days)
}
