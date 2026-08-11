import type { components, paths } from "./swagger";

/**
 * Helper type to access schemas from the generated Torn OpenAPI specification
 */
export type TornSchema<T extends keyof components["schemas"]> =
	components["schemas"][T];

/**
 * Utility type to extract operation from path
 */
export type PathOperation<P extends keyof paths> = paths[P] extends {
	get: infer Op;
}
	? Op
	: never;

/**
 * Utility type to extract successful response from operation
 */
export type OperationResponse<Op> = Op extends {
	responses: { 200: { content: { "application/json": infer R } } };
}
	? R
	: never;

/**
 * Utility type to extract query parameters from operation
 */
export type OperationQueryParams<Op> = Op extends {
	parameters: { query?: infer Q };
}
	? Q extends Record<string, unknown>
		? Q
		: Record<string, never>
	: Record<string, never>;

/**
 * Utility type to extract path parameters from operation
 */
export type OperationPathParams<Op> = Op extends {
	parameters: { path?: infer P };
}
	? P extends Record<string, unknown>
		? P
		: Record<string, never>
	: Record<string, never>;
