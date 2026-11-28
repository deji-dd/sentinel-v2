import { useEffect, useState } from "react";

import { parseRoute, type RouteKey } from "@/lib/navigation";

/** Minimal hash router — no react-router dependency needed for eight pages. */
export function useHashRoute(): RouteKey {
	const [route, setRoute] = useState<RouteKey>(() =>
		parseRoute(window.location.hash),
	);

	useEffect(() => {
		const onChange = () => setRoute(parseRoute(window.location.hash));
		window.addEventListener("hashchange", onChange);
		return () => window.removeEventListener("hashchange", onChange);
	}, []);

	return route;
}
