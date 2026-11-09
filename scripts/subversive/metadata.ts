export function getMetadataHeader(version: string): string {
	return `// ==UserScript==
// @name         Subversive Alliance
// @namespace    subversive.torn
// @version      ${version}
// @description  Ranked war target finder, bounties and family chat for Subversive Alliance
// @author       Blasted [1934909]
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @connect      api.blasted-labs.tech
// @connect      subversive.blasted-labs.tech
// @connect      api.klipy.com
// @connect      localhost
// @connect      *
// @downloadURL  https://api.blasted-labs.tech/v2/subversive/script.user.js
// @updateURL    https://api.blasted-labs.tech/v2/subversive/script.user.js
// @run-at       document-idle
// ==/UserScript==`;
}
