/** Type surface for the publisher's exact-byte feed renderer. */
export function renderFeed<T extends {version:string;channel:string;kind:string;security:boolean;date:string;notes:{de:string;en:string};minFromVersion:string}>(metadata:T,bundle:Uint8Array,latest:Uint8Array):T&{bundle:string;tauri:string};
