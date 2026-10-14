# Proxy per Project

Each project can run a local TCP proxy that speaks the PostgreSQL protocol. Your app connects to one fixed address, and bbdump routes it to the database of the project you choose: switch from the local copy to staging or production without touching your app's configuration.

## How it works

1. Your app connects to `localhost:<port>` with the project's proxy URL.
2. The proxy accepts the connection, then connects to the target database with that database's real credentials (password, SSL, SSH tunnel) and forwards the traffic both ways.
3. When you switch the target, new connections go to the new database. Connections already open stay on the previous one until your app closes them.

The proxy listens on `127.0.0.1` only: it cannot be reached from another machine.

## Turning it on

1. On the **Databases** page, click **Proxy** in the project header.
2. bbdump picks a free port from `54320` (you can change it).
3. Pick the database it should route to: the proxy starts.

The header then shows a pill `:port → database`: green when the proxy runs, amber when it still needs a target. Click it to open the switch:

- **Your app** → the stable URL (click to copy) → the project's databases, where one click changes the target;
- the status and number of connections, the port (editable), the activity log, and the on/off switch.

The database the proxy routes to carries a **proxy** badge; the others offer **Set as proxy target** in their **⋯** menu.

### Connection URL

```
postgresql://<project>:<project>@localhost:<port>/<project>
```

`<project>` is the project name as a slug. The user, password and database name in this URL are placeholders: the proxy does not check them, and always logs in to the target with the credentials saved in bbdump. Your app never sees the real password.

## Switching the target

- From the app: in the proxy switch, or with **Set as proxy target** on a database.
- From the menu bar: when a project's proxy is on, each of its databases has a radio button; click one to route the proxy there.

Both ask for confirmation. If the proxy is on but stopped, choosing a target from the app starts it.

## Good to know

- Proxies that were on start again when bbdump launches, and keep running while the window is closed (bbdump stays in the menu bar).
- A database on a server via SSH works too: the proxy keeps its tunnel open while it runs.
- SSL modes and CA certificates of the target apply (with SNI). Between your app and the proxy, on localhost, the connection is not encrypted.
- Changing the port restarts a running proxy on the new one.
- The **activity log** lists starts, stops, client connections and target switches.

## Use cases

- **Local development:** keep one `DATABASE_URL` in your `.env` and switch between your local copy, an anonymized duplicate, or staging.
- **Several services:** point them all at the proxy, and change the target once instead of updating each one.
- **Debugging against production:** route to production for a moment, then back. Prefer a read-only role on the production side.
- **Screen sharing:** **Mask**, next to a project name, hides the names of the project and its databases.
