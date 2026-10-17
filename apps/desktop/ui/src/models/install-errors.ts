/** Only known native reason codes select copy. Free-form errors never enter the DOM. */
export function installError(error:unknown):"checksum"|"signature"|"unconfigured"|"collision"|"failed" {
 switch(error){case "installer-checksum":return "checksum";case "installer-signature":return "signature";case "installer-unconfigured":return "unconfigured";case "shim-collision":case "shim-path-collision":return "collision";default:return "failed";}
}
