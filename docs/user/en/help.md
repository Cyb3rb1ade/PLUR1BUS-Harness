# Help and user handbook

Open **Help** at the bottom of the sidebar (`#/help`). The handbook is available to all signed-in roles: Owner, Admin, Operator, Member and Viewer. A documented feature may require additional permissions; reading its instructions does not grant them. The German version is [hilfe.md](../de/hilfe.md).

## Find a chapter

The table of contents is on the left, with the selected chapter beside it. An address without a chapter opens the first page in the table of contents; this is not necessarily the quickstart.

**Search handbook…** filters the table of contents by title and filename, ignoring case. The query is evaluated locally. It does not search chapter contents, chats or memories. Clear the query to show every chapter again.

Pages are bundled with the application. Loading the handbook itself does not visit an external documentation site; its content matches the shipped build. External links inside a chapter can open other websites.

## Links and language

You can link directly to a chapter, such as `#/help/de/quickstart` for the German quickstart or `#/help/en/quickstart` for English. A second `#` addresses a chapter heading, for example `#/help/en/operations#directories`.

Without a language prefix, the handbook follows the interface language. If that language lacks the requested filename, an English page with the same filename is used when available. `de/` or `en/` explicitly pins the language. Many chapters link to their other-language version; this opens that chapter in the chosen language without switching the interface language.

An unknown chapter shows **Page not found in handbook**. A loading failure offers a retry. A query with no matches only means no title or filename matches it.

## Next

- Getting started: [quickstart.md](quickstart.md)
- General settings: [general-settings.md](general-settings.md)
- Open pages and fields faster: [Command palette](command-palette.md)
