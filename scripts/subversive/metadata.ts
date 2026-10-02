export function getMetadataHeader(version: string): string {
	return `// ==UserScript==
// @name         Subversive Alliance
// @namespace    subversive.torn
// @version      ${version}
// @description  Userscript for Subversive Alliance
// @author       Blasted [1934909]
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @connect      subversive.blasted-labs.tech
// @connect      localhost
// @connect      *
// @downloadURL  https://subversive.blasted-labs.tech/v2/target-finder/script.user.js
// @updateURL    https://subversive.blasted-labs.tech/v2/target-finder/script.user.js
// @run-at       document-idle
// ==/UserScript==`;
}
