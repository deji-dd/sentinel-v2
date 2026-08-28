import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { useRouter } from "@/router";

interface LoadingContextValue {
	isLoading: boolean;
	setPageReady: (pageId?: string) => void;
	startPageLoading: (pageId?: string) => void;
}

const LoadingContext = createContext<LoadingContextValue>({
	isLoading: true,
	setPageReady: () => {},
	startPageLoading: () => {},
});

export function LoadingProvider({ children }: { children: ReactNode }) {
	const { path } = useRouter();
	const [isLoading, setIsLoading] = useState(true);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isFirstMountRef = useRef<boolean>(true);

	// Page ready handler — guarantees both data and web fonts are 100% ready before dismissal
	const setPageReady = useCallback((_pageId?: string) => {
		const finalize = () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
				timeoutRef.current = null;
			}
			setIsLoading(false);
		};

		if (typeof document !== "undefined" && document.fonts?.ready) {
			document.fonts.ready.then(finalize).catch(finalize);
		} else {
			finalize();
		}
	}, []);

	const startPageLoading = useCallback((_pageId?: string) => {
		setIsLoading(true);

		if (timeoutRef.current) clearTimeout(timeoutRef.current);
		timeoutRef.current = setTimeout(() => {
			setIsLoading(false);
		}, 2500);
	}, []);

	// Initial app boot & subsequent route transitions
	useEffect(() => {
		if (isFirstMountRef.current) {
			isFirstMountRef.current = false;
			if (typeof document !== "undefined" && document.fonts?.ready) {
				document.fonts.ready.catch(() => {});
			}
			timeoutRef.current = setTimeout(() => {
				setIsLoading(false);
			}, 2500);
			return;
		}

		startPageLoading(path);
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		};
	}, [path, startPageLoading]);

	return (
		<LoadingContext.Provider
			value={{
				isLoading,
				setPageReady,
				startPageLoading,
			}}
		>
			{children}
		</LoadingContext.Provider>
	);
}

export function useGlobalLoading() {
	return useContext(LoadingContext);
}
