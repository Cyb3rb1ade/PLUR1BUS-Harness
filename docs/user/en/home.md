# Home page

The Home page (`#/home`) combines links and a brief system status. Open it through the browser address. It has no sidebar entry; the application's normal landing page is **Chat**. The German version is [start.md](../de/start.md).

## Documentation and repositories

**User Handbook** opens the bundled quickstart page; **Operations & FAQ** opens the operations handbook. Both stay inside the application. Links to the three project repositories and the official website open a new tab. Contact and donation links appear only when an address has been configured for them.

Links remain usable when system status cannot be loaded. See [Help](help.md) for handbook navigation.

## Read system status

The status card loads information from the API and core when opened. It shows **Version & Build**, **Core Status** and, where reported, **Process State**, **Engine Ready** and **Uptime** in seconds. Missing information is not replaced with invented values: a missing version appears as a dash; other unreported fields are omitted.

Owner, Admin and Operator may read status. Member and Viewer see **Status is not available for your role**. This message says nothing about whether the core is running.

If neither status source answers, for reasons beyond missing permissions alone, the card shows **Disconnected** and **Retry**. If only one source answers, its available information is shown. The page does not refresh status periodically in the background.

For detailed checks and logs, open [Status and logs](diagnostics.md). Home does not start repairs or change configuration.
