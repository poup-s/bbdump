# Proxy Server

bbdump includes a built-in TCP proxy that lets you route local PostgreSQL connections to any database in a project. This is useful for switching between production, staging, and local databases without changing your application configuration.

## How It Works

1. Enable the proxy on a project
2. bbdump starts a local TCP server that speaks the PostgreSQL protocol
3. Point your application to the proxy's local connection string
4. bbdump forwards all traffic to the selected target database
5. Switch targets instantly — your app's connection string never changes

## Enabling the Proxy

1. Go to the **DB** tab
2. On the project header, toggle **PROXY** to on
3. Click **Configure** to set the proxy port and credentials
4. Select a **target database** — click the green dot next to any database in the project

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| **Port** | Local port the proxy listens on | Auto-assigned |
| **User** | Username for the proxy connection | Project slug |
| **Password** | Password for the proxy connection | Project slug |
| **Database** | Database name for the proxy connection | Project slug |

### Connection String

Once enabled, a connection string is displayed on the project header:

```
postgresql://{user}:{password}@localhost:{port}/{database}
```

Click the copy icon to copy it to your clipboard. Use this string in your application's database configuration.

## Switching Targets

The proxy target is indicated by a green dot on the database row. To switch:

1. Click the target indicator on another database in the same project
2. The proxy immediately reroutes all new connections to the new target
3. Existing connections are closed gracefully

This allows you to switch between production, staging, and local databases with zero configuration change in your application.

## Activity Log

Click the proxy status indicator to view the activity log:

- Connection events (open/close)
- Bytes transferred
- Target switches
- Errors

## Use Cases

### Local Development

Point your development environment to `localhost:54321` and switch between:
- **Local copy** for development
- **Staging** for integration testing
- **Production** for debugging (read-only recommended)

### Screen Sharing / Demos

Use the **Mask** feature on the project to hide credentials, then demonstrate the proxy switching between environments without exposing sensitive information.

### Multiple Services

If multiple services connect to the same database, configure them all to use the proxy. When you need to switch environments, change the proxy target once instead of updating every service.
