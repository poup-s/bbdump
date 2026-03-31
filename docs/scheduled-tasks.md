# Scheduled Tasks

bbdump supports automatic backup scheduling using cron expressions. Tasks run in the background as long as the app is open.

## Creating a Scheduled Task

1. Go to the **Tasks** tab
2. Click the **+** button
3. Select a **database**
4. Configure the **schedule**
5. Save

## Schedule Configuration

### Presets

Quick-select common schedules:

| Preset | Cron Expression | Description |
|--------|----------------|-------------|
| Every minute | `* * * * *` | For testing only |
| Every 5 minutes | `*/5 * * * *` | High-frequency monitoring |
| Every 15 minutes | `*/15 * * * *` | Frequent backups |
| Every 30 minutes | `*/30 * * * *` | Semi-frequent backups |
| Every hour | `0 * * * *` | Hourly at :00 |
| Every 6 hours | `0 */6 * * *` | 4 times per day |
| Every 12 hours | `0 */12 * * *` | Twice per day |
| Daily at 2 AM | `0 2 * * *` | Standard daily backup |
| Daily at midnight | `0 0 * * *` | Midnight backup |
| Weekly (Sunday 2 AM) | `0 2 * * 0` | Weekly backup |
| Monthly (1st at 2 AM) | `0 2 1 * *` | Monthly backup |
| Weekdays at 8 AM | `0 8 * * 1-5` | Business days only |

### Custom Cron Expression

Enter a standard 5-field cron expression:

```
┌───────── minute (0-59)
│ ┌───────── hour (0-23)
│ │ ┌───────── day of month (1-31)
│ │ │ ┌───────── month (1-12)
│ │ │ │ ┌───────── day of week (0-7, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

**Examples:**

| Expression | Meaning |
|------------|---------|
| `0 3 * * *` | Every day at 3:00 AM |
| `0 */4 * * *` | Every 4 hours |
| `30 1 * * 1` | Every Monday at 1:30 AM |
| `0 0 1,15 * *` | 1st and 15th of each month at midnight |

bbdump displays a human-readable description of the schedule (in English or French depending on your language setting).

## Task Management

The Tasks tab displays a table with:

| Column | Description |
|--------|-------------|
| **Database** | Target database name |
| **Schedule** | Visual representation of the cron expression |
| **Last Backup** | Date and time of the most recent backup |
| **Status** | Active (green) or Paused |

### Task Actions

- **Pause/Resume** — Temporarily disable a task without deleting it
- **Edit** — Change the schedule or target database
- **Delete** — Remove the scheduled task permanently

## How It Works

- Tasks are powered by `node-cron` running in the Electron main process
- Backups are triggered automatically at the scheduled time
- The app must be running for scheduled tasks to execute
- Each task execution creates a standard backup (same as manual backups)
- All task activity is logged in the **Logs** tab

## Retention

Backup retention is configured per-task. Older backups beyond the retention period are automatically cleaned up.
