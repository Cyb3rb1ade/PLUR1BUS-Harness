/** Owner-facing, read-only OpenSSH setup templates; these instructions never execute on the source. */

/** Return bounded setup text for a generated SSH public key; installation paths must be verified on the source. */
export function readonlySshInstructions(publicKey: string): string {
  // OpenSSH sshd(8): restrict disables forwarding, PTY and user rc; command fixes the session executable.
  // OpenSSH sftp-server(8): -R denies write opens and filesystem-changing operations.
  // Microsoft OpenSSH_KeyManagement: administrator keys use ProgramData and Admin/System-only ACLs.
  const line = (path: string) => `restrict,command="${path} -R" ${publicKey} plur1bus-import`;
  return [
    "On the source, use a dedicated account with access only to the intended import files.",
    "Choose ONE template below and verify the sftp-server path on the source before installing it; package layouts vary.",
    "Append the complete restricted line to that account's ~/.ssh/authorized_keys; do not install the bare public key.",
    "Debian/Ubuntu:", line("/usr/lib/openssh/sftp-server"),
    "Fedora/RHEL:", line("/usr/libexec/openssh/sftp-server"),
    "Arch:", line("/usr/lib/ssh/sftp-server"),
    "macOS: enable Remote Login in System Settings > General > Sharing for the source account.",
    line("/usr/libexec/sftp-server"),
    "Unix: the account must own ~/.ssh and authorized_keys; use permissions 700 and 600 respectively.",
    "Windows OpenSSH (standard Windows installation; replace the path if installed elsewhere):",
    line("C:/Windows/System32/OpenSSH/sftp-server.exe"),
    "Windows standard account: %USERPROFILE%\\.ssh\\authorized_keys.",
    "Windows administrator account: %ProgramData%\\ssh\\administrators_authorized_keys instead of the profile file.",
    "For that administrator file, disable inherited ACLs and allow only Administrators and SYSTEM.",
    "The forced command replaces shell sessions; -R provides read-only SFTP. restrict denies PTY and forwarding.",
  ].join("\n");
}
