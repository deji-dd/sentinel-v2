/**
 * Compatibility for userscript managers that only expose the Promise-based
 * GM.* API — notably Userscripts for Safari (quoid/userscripts).
 *
 * Both of our scripts use the legacy synchronous GM_getValue / GM_setValue API
 * in a lot of places, including module-level state initialization. Managers
 * that do not provide those aliases make the script throw a ReferenceError
 * before the floating launcher is mounted, even though other scripts (which
 * use the newer API) work fine.
 *
 * When the legacy API is missing we install synchronous equivalents backed by
 * localStorage and mirror writes to GM.setValue when the manager offers it.
 */
declare const GM_getValue: unknown;

type UnknownRecord = Record<string, unknown>;

(function installGmCompat() {
	if (typeof GM_getValue === "function") return;

	const root = globalThis as UnknownRecord;

	const managerApi = (): UnknownRecord | undefined => {
		const gm = root.GM;
		return gm && typeof gm === "object" ? (gm as UnknownRecord) : undefined;
	};

	const read = <T>(key: string, fallback?: T): T => {
		try {
			const raw = localStorage.getItem(key);
			return raw === null ? (fallback as T) : (JSON.parse(raw) as T);
		} catch {
			return fallback as T;
		}
	};

	const write = <T>(key: string, value: T): void => {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {}
		const gm = managerApi();
		const setValue = gm?.setValue;
		if (typeof setValue === "function") {
			try {
				Promise.resolve(setValue.call(gm, key, value)).catch(() => {});
			} catch {}
		}
	};

	root.GM_getValue = read;
	root.GM_setValue = write;
	root.GM_registerMenuCommand ??= () => {};
	root.GM_openInTab ??= (url: string) => {
		const gm = managerApi();
		const openInTab = gm?.openInTab;
		if (typeof openInTab === "function") {
			try {
				Promise.resolve(openInTab.call(gm, url, false)).catch(() => {});
			} catch {}
		} else {
			try {
				window.open(url, "_blank");
			} catch {}
		}
		return { close() {} };
	};
})();

export {};
