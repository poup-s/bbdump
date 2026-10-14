# Scheduled Tasks

bbdump backs up your databases on a schedule, per database. Scheduled backups are the only kind of task: each one is a normal backup (same settings, verification, encryption and retention, see [Backup & Restore](backup-and-restore.md)).

## Setting a schedule

A schedule belongs to a database. Set it when adding the database (last step), or later in its settings, **Schedule** section:

1. Turn on **Back up automatically**.
2. Choose the frequency in the cron editor.
3. Save.

The pencil on the **Tasks** page opens the same section.

### Cron editor

Three modes:

- **Preset**: a list of common schedules.
- **Visual**: minute, hour, day, month and day of week, each as a field.
- **Manual**: a 5-field cron expression.

The schedule is shown in plain words (English or French, following the app's language).

| Preset | Expression |
|--------|------------|
| Every minute | `* * * * *` |
| Every hour | `0 * * * *` |
| Daily (midnight) | `0 0 * * *` |
| Daily (2 AM) | `0 2 * * *` |
| Daily (6 AM) | `0 6 * * *` |
| Daily (noon) | `0 12 * * *` |
| Weekly (Sunday, midnight) | `0 0 * * 0` |
| Monthly (1st, midnight) | `0 0 1 * *` |
| Twice daily | `0 0,12 * * *` |
| Every 6 hours | `0 */6 * * *` |
| Every 12 hours | `0 */12 * * *` |
| Weekdays only (midnight) | `0 0 * * 1-5` |

Cron format:

```
┌───────── minute (0-59)
│ ┌───────── hour (0-23)
│ │ ┌───────── day of month (1-31)
│ │ │ ┌───────── month (1-12)
│ │ │ │ ┌───────── day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

Examples: `0 3 * * *` (every day at 3:00), `30 1 * * 1` (Mondays at 1:30), `0 0 1,15 * *` (the 1st and 15th at midnight).

## Tasks page

![Scheduled tasks](../captures/tasks.webp)

At the top: the next backup, and how many databases are scheduled, off, or failed on their last run.

Each scheduled database shows:

- its schedule in words and its cron expression, with what applies to its backups: how many are kept, **Verified**, **Encrypted**;
- the next run ("in 3 hours", with the day and time), or **Backing up…** while it runs;
- the last runs as a strip of up to 12 marks, green or red. Hover one for its date, what started it (manual, scheduled, caught up), its duration and size;
- the error of the last run when it failed;
- **Back up now**, a switch to turn automatic backups off or on, and the pencil to edit the schedule.

Databases without automatic backups are listed under **Automatic backups off**, with **Turn on** (when a schedule is already set) and **Set up**.

When a scheduled backup fails, a system notification says so, since bbdump usually runs hidden. Each database keeps its last 30 runs (in `backup-history.json`).

## Launch at login

Scheduled backups only run while bbdump is open. Turn on **Settings → General → Launch at login**: bbdump then starts hidden in the menu bar when you log in (a login item on macOS, an autostart entry on Linux). The **Tasks** page suggests it when backups are scheduled and it is off.

## Missed backups

About 30 seconds after bbdump starts, it checks each scheduled database: if the last expected run passed while bbdump was closed (looking back up to 31 days) and no backup was made since, one backup runs, marked **caught up**. Missed backups run one after another, and only once, however many runs were missed.

The **Tasks** page flags a database whose scheduled backup was missed.

## Good to know

- A backup still running when the next one is due is not started twice: the next one is skipped.
- An invalid cron expression never runs; the **Tasks** page says so.
- All activity is in the **Logs** page.
