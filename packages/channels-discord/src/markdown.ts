// Discord renders CommonMark-ish text natively, so "conversion" is sanitising: keep code fences/spans and all formatting
// intact, defuse everything that would resolve to a mention or a navigation token, and drop control characters.
// This is the first of two guards: every outbound message additionally carries `allowed_mentions: { parse: [] }`.

const ZWSP = "​";
// <@id> <@!id> <@&id> <#id> </command:id> — a zero-width space after "<" stops Discord from resolving them.
const ANGLE_TOKEN = /<(?=[@#]|\/[^\s>]*:\d)/g;
const BROADCAST = /@(?=everyone|here)/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function defuse(plain: string): string {
  return plain.replace(ANGLE_TOKEN, `<${ZWSP}`).replace(BROADCAST, `@${ZWSP}`);
}

/** Code fences (``` … ``` or to the end if unterminated) and inline code spans are copied verbatim. */
export function toPlatformMarkdown(text: string): string {
  const src = text.replace(/\r\n?/g, "\n").replace(CONTROL, "");
  let out = "";
  let i = 0;
  let plainStart = 0;
  const flush = (end: number) => {
    out += defuse(src.slice(plainStart, end));
  };
  while (i < src.length) {
    if (src.startsWith("```", i)) {
      flush(i);
      const close = src.indexOf("```", i + 3);
      const end = close === -1 ? src.length : close + 3;
      out += src.slice(i, end);
      i = plainStart = end;
    } else if (src[i] === "`") {
      const close = src.indexOf("`", i + 1);
      if (close === -1 || src.slice(i + 1, close).includes("\n")) {
        i++;
        continue;
      }
      flush(i);
      out += src.slice(i, close + 1);
      i = plainStart = close + 1;
    } else i++;
  }
  flush(src.length);
  return out;
}
