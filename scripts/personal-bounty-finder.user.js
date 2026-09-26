// ==UserScript==
// @name         Bounty Target Finder
// @namespace    sentinel.torn
// @version      3.0.0
// @description  [RETIRED] Bounty target finder has been merged into the Subversive Alliance userscript
// @author       Blasted [1934909]
// @match        https://www.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @downloadURL  https://sentinel.blasted-labs.tech/api/v1/personal/bounties/script.user.js
// @updateURL    https://sentinel.blasted-labs.tech/api/v1/personal/bounties/script.user.js
// @run-at       document-idle
// ==/UserScript==

(() => {
	// Clean up legacy DOM elements and listeners
	const host = document.getElementById("personal-bounty-finder-host");
	if (host) {
		host.remove();
	}
	const legacyPanel = document.getElementById("pbtf-panel");
	if (legacyPanel) {
		legacyPanel.remove();
	}

	// Clean up legacy storage keys
	try {
		GM_setValue("pbtf_panel_open", false);
	} catch {}

	console.info(
		"[Bounty Target Finder] This script is retired and its features have been merged into the Subversive Alliance userscript. Please uninstall this userscript.",
	);
})();
