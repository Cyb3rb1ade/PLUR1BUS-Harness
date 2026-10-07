/**
 * A path literal that is absolute on the running platform. The tests spell paths POSIX-style ("/work/x");
 * on Windows the path layer (rightly) refuses a rooted path without a drive, so those spellings get "C:" in front.
 * Nothing touches the disk with these: they are policy inputs and grant matches.
 */
export const abs = (p: string): string => (process.platform === "win32" && p.startsWith("/") ? `C:${p}` : p);
