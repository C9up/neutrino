/**
 * What an interceptor needs to protect a gRPC call: a typed slot to hand the
 * method a value, and the two protections HTTP gets from middleware —
 * authentication and rate limiting — for the calls middleware never sees.
 *
 *   import auth from "@c9up/warden/services/main"
 *
 *   const signedIn = bearerAuth(auth, { guard: "jwt" })
 *   grpc.use(signedIn.interceptor)
 *   grpc.service(AccountService, {
 *     me: (_request, context) => ({ id: String(signedIn.user(context).id) }),
 *   })
 *
 * Both take the protecting object structurally — warden's auth manager,
 * blackhole — so neutrino imports neither.
 */

import {
	type GrpcContext,
	GrpcError,
	type GrpcInterceptor,
	GrpcStatus,
} from "./GrpcServices.js";

/**
 * A value an interceptor sets on a call for the method (or a later
 * interceptor) to read. Each call has its own; nothing outlives it.
 */
export class GrpcContextKey<T> {
	// Boxed, so a value that is itself null or undefined is told apart from
	// no value at all.
	readonly #values = new WeakMap<GrpcContext, { value: T }>();
	readonly #fallback: T;

	constructor(fallback: T) {
		this.#fallback = fallback;
	}

	get(context: GrpcContext): T {
		const slot = this.#values.get(context);
		return slot === undefined ? this.#fallback : slot.value;
	}

	set(context: GrpcContext, value: T): void {
		this.#values.set(context, { value });
	}
}

/**
 * Anything that turns a bearer token into a user — warden's auth manager
 * (`verify(token, guard)`) fits as it is.
 */
export interface TokenVerifier<User> {
	verify(
		token: string,
		guard?: string,
	): Promise<{
		authenticated: boolean;
		user?: User;
		/** The verifier itself failed, as opposed to refusing the token. */
		strategyCrash?: boolean;
	}>;
}

export interface BearerAuth<User> {
	/** Refuses a call without a valid `authorization: Bearer <token>`. */
	readonly interceptor: GrpcInterceptor;
	/**
	 * The user the token belongs to. Throws UNAUTHENTICATED on a call the
	 * interceptor did not run for, so a method that forgot to require it
	 * fails closed.
	 */
	user(context: GrpcContext): User;
}

const BEARER = /^bearer\s+(\S+)$/i;

export function bearerAuth<User>(
	verifier: TokenVerifier<User>,
	options: { guard?: string } = {},
): BearerAuth<User> {
	const users = new GrpcContextKey<User | undefined>(undefined);
	return {
		async interceptor(context, next) {
			const token = BEARER.exec(context.metadata.authorization ?? "")?.[1];
			if (token === undefined) {
				throw new GrpcError(GrpcStatus.UNAUTHENTICATED, "Missing bearer token");
			}
			const result = await verifier.verify(token, options.guard);
			if (result.strategyCrash === true) {
				// The verifier broke, the client did nothing wrong: INTERNAL,
				// like the 500 HTTP answers in the same case.
				throw new Error("The token verifier failed");
			}
			if (!result.authenticated || result.user === undefined) {
				throw new GrpcError(GrpcStatus.UNAUTHENTICATED, "Invalid token");
			}
			users.set(context, result.user);
			return next();
		},
		user(context) {
			const user = users.get(context);
			if (user === undefined) {
				throw new GrpcError(GrpcStatus.UNAUTHENTICATED, "Not authenticated");
			}
			return user;
		},
	};
}

/**
 * Anything that counts calls per key — blackhole with a `rateLimit.store`
 * configured (`checkRateLimit(key)`) fits as it is.
 */
export interface CallLimiter {
	checkRateLimit(
		key: string,
	): Promise<{ allowed: boolean; resetSeconds: number }>;
}

/**
 * Refuses a call over the limit with RESOURCE_EXHAUSTED. The key defaults to
 * the client IP — the key blackhole counts HTTP requests under, so with the
 * same store a client has one budget for both.
 */
export function rateLimit(
	limiter: CallLimiter,
	options: { keyFor?: (context: GrpcContext) => string } = {},
): GrpcInterceptor {
	const keyFor = options.keyFor ?? ((context: GrpcContext) => context.ip);
	return async (context, next) => {
		const decision = await limiter.checkRateLimit(keyFor(context));
		if (!decision.allowed) {
			throw new GrpcError(
				GrpcStatus.RESOURCE_EXHAUSTED,
				`Too many requests — retry in ${decision.resetSeconds}s`,
			);
		}
		return next();
	};
}
