// Typed failures for the file tools. Same contract as the web tools (D97 item 3): a code, a hint for the agent and one
// sentence for the person; never a stack and never a host absolute path.
import type { RefusalReason } from "../../policy/paths-index.ts";

export type FsFailureCode =
  | "invalid-arguments"
  | "path-refused"
  | "not-found"
  | "not-a-file"
  | "not-a-directory"
  | "exists"
  | "too-large"
  | "binary-content"
  | "changed"
  | "aborted"
  | "io-error"
  | "internal-error";

const TEXTS: Record<FsFailureCode, { hint: string; userAction: string }> = {
  "invalid-arguments": { hint: "Fix the arguments named in the message and call again.", userAction: "I called the tool with a malformed request; I will correct it." },
  "path-refused": { hint: "The path is outside the folders you may use, or is not allowed. Use a path inside a granted folder; do not try to work around it.", userAction: "That location is not one I am allowed to use; a folder can be granted in the settings." },
  "not-found": { hint: "Nothing exists at that path. List the parent directory to see what is there.", userAction: "I could not find that file." },
  "not-a-file": { hint: "The target is not a regular file (directory, device, pipe or socket). Use file.list for directories.", userAction: "That is not an ordinary file, so I did not open it." },
  "not-a-directory": { hint: "The target is not a directory. Use file.read or file.stat for files.", userAction: "That is not a folder." },
  exists: { hint: "A file already exists there. Pass overwrite: true only if replacing it is intended, or choose another name.", userAction: "A file with that name already exists; should I replace it?" },
  "too-large": { hint: "The size exceeds the limit. Read a range with offset and length, or write less.", userAction: "That file is too large to handle in one go." },
  "binary-content": { hint: "The content is not valid UTF-8 text. Ask for encoding: \"base64\" if the bytes are really needed.", userAction: "That file is binary, not text." },
  changed: { hint: "The file or its directory changed while the tool worked and the operation was stopped. Check the state and retry once.", userAction: "The file changed while I was working on it, so I stopped." },
  aborted: { hint: "The operation was cancelled.", userAction: "The operation was cancelled." },
  "io-error": { hint: "The file system reported an error. Retry once; if it persists use another approach.", userAction: "The file system reported an error." },
  "internal-error": { hint: "The tool failed unexpectedly. Retry once; if it persists use another approach.", userAction: "Something went wrong while handling the file." },
};

export class FsFailure extends Error {
  readonly code: FsFailureCode;
  readonly hint: string;
  readonly userAction: string;
  /** For `path-refused`: the policy's reason (e.g. `outside-root`, `deny-listed`). */
  readonly reason: RefusalReason | undefined;

  constructor(code: FsFailureCode, message: string, reason?: RefusalReason) {
    super(message);
    this.name = "FsFailure";
    this.code = code;
    this.hint = TEXTS[code].hint;
    this.userAction = TEXTS[code].userAction;
    this.reason = reason;
  }

  toResult(): { isError: true; error: { code: FsFailureCode; message: string; hint: string; userAction: string; reason?: RefusalReason } } {
    return { isError: true, error: { code: this.code, message: this.message, hint: this.hint, userAction: this.userAction, ...(this.reason ? { reason: this.reason } : {}) } };
  }
}
