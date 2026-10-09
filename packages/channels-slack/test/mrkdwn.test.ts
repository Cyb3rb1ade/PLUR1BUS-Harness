import assert from "node:assert/strict";
import { test } from "node:test";
import { slackToPlain, toSlackMrkdwn } from "../src/index.ts";

const ZW = "​";

test("markdown to mrkdwn: table-driven formatting", () => {
  const cases: Array<[string, string, string]> = [
    ["bold", "**bold**", "*bold*"],
    ["bold underscore", "__b2__", "*b2*"],
    ["italic star", "*it*", "_it_"],
    ["italic underscore", "_it2_", "_it2_"],
    ["bold italic", "***both***", "*_both_*"],
    ["strike", "~~gone~~", "~gone~"],
    ["inline code keeps markers literal", "`code *x*`", "`code *x*`"],
    ["inline code escapes control chars", "`a<b&c`", "`a&lt;b&amp;c`"],
    ["fenced block", "```js\nconst a = 1;\n```", "```\nconst a = 1;\n```"],
    ["fenced block with tilde", "~~~\nx\n~~~", "```\nx\n```"],
    ["link", "[docs](https://example.com/a)", "<https://example.com/a|docs>"],
    ["link query ampersand escaped", "[d](https://e.test/a?b=1&c=2)", "<https://e.test/a?b=1&amp;c=2|d>"],
    ["autolink", "<https://x.test/p>", "<https://x.test/p>"],
    ["image becomes link", "![alt](https://img.test/a.png)", "<https://img.test/a.png|alt>"],
    ["javascript link refused", "[bad](javascript:alert(1))", "bad (javascript:alert(1))"],
    ["bullet list", "- one\n- two", "• one\n• two"],
    ["nested bullet", "- one\n  - nested", "• one\n    • nested"],
    ["ordered list", "1. first\n2) second", "1. first\n2. second"],
    ["task list", "- [ ] todo\n- [x] done", "• ☐ todo\n• ☑ done"],
    ["quote", "> quoted *text*\n> more", "> quoted _text_\n> more"],
    ["heading to bold line", "# Title\ntext", "*Title*\ntext"],
    ["horizontal rule", "a\n\n---\n\nb", "a\n\n──────────\n\nb"],
    ["table becomes code block", "| a | b |\n|---|---|\n| 1 | 2 |", "```\na | b\n--+--\n1 | 2\n```"],
    ["backslash escape of marker", "a\\*b", "a*b"],
    ["backslash escape of angle", "\\<c\\>", "&lt;c&gt;"],
    ["snake case untouched", "snake_case_name", "snake_case_name"],
    ["unclosed bold stays literal", "**open", `${ZW}*${ZW}${ZW}*${ZW}open`],
    ["plain ampersand", "a & b", "a &amp; b"],
  ];
  for (const [name, input, want] of cases) assert.equal(toSlackMrkdwn(input), want, name);
});

test("injection attempts: mentions, broadcasts, raw tags and link tokens are neutralised", () => {
  const cases: Array<[string, string, string]> = [
    ["channel broadcast", "<!channel> ping", "&lt;!channel&gt; ping"],
    ["here broadcast with label", "<!here|here> ping", "&lt;!here|here&gt; ping"],
    ["everyone", "@<!everyone>", "@&lt;!everyone&gt;"],
    ["user mention", "hi <@UABCDEF1>", "hi &lt;@UABCDEF1&gt;"],
    ["channel mention", "see <#C0FAKE01|general>", "see &lt;#C0FAKE01|general&gt;"],
    ["raw link token with label", "<http://x|y>", "<http://x%7Cy>"],
    ["link label injection via markdown", "[<!channel>](https://ok.test)", "<https://ok.test|&lt;!channel&gt;>"],
    ["pipe in link url", "[a](https://x.test/a|b)", "<https://x.test/a%7Cb|a>"],
    ["destination with angle tag", "[x](<!channel>)", "x (!channel)"],
    ["html tag", "<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ["mention inside code block", "```\n<!channel>\n```", "```\n&lt;!channel&gt;\n```"],
    ["mention inside table", "| x |\n|---|\n| <@U1> |", "```\nx\n-----\n&lt;@U1&gt;\n```"],
    ["backtick breakout in code", "```\n```<!channel>\n```", "```\n``" + ZW + "`" + "&lt;!channel&gt;\n```"],
  ];
  for (const [name, input, want] of cases) {
    const out = toSlackMrkdwn(input);
    assert.equal(out, want, name);
    assert.doesNotMatch(out, /<!|<@|<#|<!subteam/, `${name}: no control token survives`);
    assert.doesNotMatch(out.replace(/<https?:\/\/[^>]*>|<mailto:[^>]*>/g, ""), /<[^>]*\|/, `${name}: no label token outside converter links`);
  }
});

test("only http(s) and mailto links are emitted", () => {
  for (const url of ["javascript:x", "data:text/html,hi", "file:///etc/passwd", "ftp://x.test/a", "https://a b.test"]) {
    const out = toSlackMrkdwn(`[x](${url})`);
    assert.doesNotMatch(out, /<(javascript|data|file|ftp):/, url);
  }
});

test("slackToPlain decodes inbound wire text", () => {
  assert.equal(slackToPlain("a &lt;b&gt; &amp; c"), "a <b> & c");
  assert.equal(slackToPlain("<https://x.test|label>"), "label (https://x.test)");
  assert.equal(slackToPlain("<https://x.test>"), "https://x.test");
  assert.equal(slackToPlain("<!channel> hi"), "@channel hi");
});
