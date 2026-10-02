/** Shared acceptance cases live in src-tauri/tests/fixtures/origin-cases.json. */
export function normalizeOrigin(input: string): string | null {
    if (input.length > 2048 || /[\s\x00-\x1f\x7f\\]/u.test(input))
        return null;
    const match = /^https?:\/\/(.*)$/i.exec(input);
    if (!match || /[@?#]/.test(match[1]!))
        return null;
    const authority = match[1]!.replace(/\/$/, "");
    if (authority.includes("%") || authority.includes("/"))
        return null;
    try {
        const url = new URL(input);
        if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && authority.split(":")[0] !== url.hostname)
            return null;
        if (url.protocol === "http:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
            return null;
        return url.origin;
    }
    catch {
        return null;
    }
}
