import { requireString } from "./errors.ts";
import { runChecked } from "./exec.ts";
import { asObject, type HostTool } from "./types.ts";

function appleEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r?\n/g, " ");
}

function psEscape(s: string): string {
  return s.replace(/`/g, "``").replace(/"/g, '`"').replace(/\$/g, "`$").replace(/[\u201C\u201D\u201E]/g, "`$&").replace(/[\r\n\u2028\u2029\u0085]+/g, " ");
}

export const notifyTool: HostTool = {
  name: "notify", capability: "sys.read", riskClass: "low",
  description: "Show a desktop notification. Text is escaped; no shell string is built from untrusted input.",
  schema: {
    input: {
      type: "object", additionalProperties: false, required: ["title"],
      properties: { title: { type: "string" }, body: { type: "string" } },
    },
    output: { type: "object", required: ["sent"], properties: { sent: { type: "boolean" } } },
  },
  async run(input, ctx) {
    const o = asObject(input);
    const title = requireString(o.title, "title", 1, 200);
    const body = o.body === undefined ? "" : requireString(o.body, "body", 0, 2000);
    if (ctx.platform === "darwin") {
      const script = `display notification "${appleEscape(body || title)}" with title "${appleEscape(title)}"`;
      await runChecked(ctx, { program: "osascript", args: ["-e", script] }, { code: "not_supported_on_platform", message: "the notification command failed" });
    } else if (ctx.platform === "linux") {
      const args = body ? ["--", title, body] : ["--", title];
      await runChecked(ctx, { program: "notify-send", args }, { code: "not_supported_on_platform", message: "the notification command failed" });
    } else {
      const t = psEscape(title);
      const b = psEscape(body);
      const cmd = `if (Get-Module -ListAvailable -Name BurntToast) { New-BurntToastNotification -Text @("${t}","${b}") } else { [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $texts = $template.GetElementsByTagName('text'); $texts.Item(0).AppendChild($template.CreateTextNode("${t}")) | Out-Null; $texts.Item(1).AppendChild($template.CreateTextNode("${b}")) | Out-Null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('PLUR1BUS').Show([Windows.UI.Notifications.ToastNotification]::new($template)) }`;
      await runChecked(ctx, { program: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", cmd] }, { code: "not_supported_on_platform", message: "the notification command failed" });
    }
    return { sent: true };
  },
};
