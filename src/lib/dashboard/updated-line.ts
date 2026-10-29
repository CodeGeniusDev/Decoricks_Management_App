/**
 * The dashboard's "last updated" sentence, as a pure function.
 *
 * Split out because the honest part of it is a decision, not markup: the
 * reported symptom was a board that read "updated 12:39 am" many hours later and
 * gave no sign that anything was wrong with it. A timestamp alone cannot express
 * that — it is true of the data on screen and says nothing about whether the app
 * is still trying. So the line is built from the two facts the data layer holds:
 * when the current payload landed, and whether it has aged past
 * `STALE_AFTER_MS` while the tab has been open.
 *
 * `lastUpdated` comes from a successful read only, which is what keeps the first
 * half honest: it can never name an instant fresher than the numbers being
 * described, so a refresh that failed leaves the line showing the age of the
 * stale snapshot rather than the time of the attempt that failed. The second half
 * then says plainly that the board is behind, instead of letting an hours-old
 * time read as though it were current.
 *
 * Lives in its own module rather than beside the chip because the suite runs in
 * node with no DOM, and the wording is the part worth pinning down.
 */
import { formatKarachiDate } from '@/lib/date'

export const updatedLine = (lastUpdated: number | null, stale: boolean): string => {
  // Before the first payload lands there is nothing to date, and the board is
  // showing a skeleton anyway. "Updated never" would be technically true and
  // useless.
  if (!lastUpdated) return 'updating…'
  const time = formatKarachiDate(new Date(lastUpdated), 'time')
  return stale ? `updated ${time}, out of date — retrying` : `updated ${time}`
}
