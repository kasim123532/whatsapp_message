/**
 * Working hours and daily limits are things people reason about in their own
 * wall-clock time, so everything here reads the process timezone (the `TZ`
 * environment variable, set in docker-compose.yml). A container with no `TZ`
 * runs on UTC, which silently shifts every campaign's send window — hence the
 * startup banner below, so a misconfigured zone is visible in the logs.
 */

/** The zone the process actually resolved, e.g. "Asia/Almaty". */
export function currentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || "UTC";
}

/** Local wall-clock time as "HH:MM", directly comparable to sendFrom/sendTo. */
export function localTimeHHMM(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Local calendar day as "YYYY-MM-DD", used to detect a daily-counter rollover. */
export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function logTimeZoneBanner() {
  const now = new Date();
  console.log(
    `[Time] Timezone ${currentTimeZone()} — local time is now ${localDayKey(now)} ${localTimeHHMM(now)}. ` +
      `Campaign working hours and daily limits follow this clock.`
  );
}
