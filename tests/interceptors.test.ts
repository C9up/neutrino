import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	bearerAuth,
	type GrpcCall,
	GrpcContextKey,
	GrpcError,
	type GrpcReply,
	GrpcServices,
	GrpcStatus,
	Protobuf,
	rateLimit,
	type TokenVerifier,
} from "../src/index.js";

const protobuf = new Protobuf({
	descriptorSets: [
		readFileSync(new URL("./fixtures/echo.binpb", import.meta.url)),
	],
});
const Echo = protobuf.service("echo.Echo");
const Admin = protobuf.service("echo.Admin");
const SayRequest = protobuf.message("echo.SayRequest");

const request = protobuf.encode(
	SayRequest,
	create(SayRequest, { text: "a", times: 1 }),
);

function call(path: string, extra: Partial<GrpcCall> = {}): GrpcCall {
	return { path, metadata: {}, ip: "203.0.113.7", message: request, ...extra };
}

function status(reply: GrpcReply): number {
	return "code" in reply ? reply.code : GrpcStatus.OK;
}

/** A service whose method records that it ran. */
function serving(log: string[]) {
	return new GrpcServices(protobuf, { onError: () => {} })
		.service(Echo, {
			say: () => {
				log.push("echo.say");
				return { text: "ok" };
			},
		})
		.service(Admin, {
			ping: () => {
				log.push("admin.ping");
				return { text: "pong" };
			},
		});
}

describe("interceptors", () => {
	it("run in order around the method: use() first, then the service's own", async () => {
		const log: string[] = [];
		const grpc = new GrpcServices(protobuf)
			.use(async (_context, next) => {
				log.push("global:before");
				const reply = await next();
				log.push("global:after");
				return reply;
			})
			.service(
				Echo,
				{
					say: () => {
						log.push("method");
						return { text: "ok" };
					},
				},
				{
					interceptors: [
						async (_context, next) => {
							log.push("service");
							return next();
						},
					],
				},
			);
		expect(status(await grpc.handle(call("/echo.Echo/Say")))).toBe(
			GrpcStatus.OK,
		);
		expect(log).toEqual(["global:before", "service", "method", "global:after"]);
	});

	it("refuse a call before its bytes are even decoded", async () => {
		const log: string[] = [];
		const grpc = serving(log).use(async () => {
			throw new GrpcError(GrpcStatus.PERMISSION_DENIED, "not you");
		});
		// Garbage bytes: decoding would answer INVALID_ARGUMENT. The refusal
		// comes first, and the method never runs.
		const reply = await grpc.handle(
			call("/echo.Echo/Say", { message: Uint8Array.from([0x0a, 0x09]) }),
		);
		expect(reply).toEqual({
			code: GrpcStatus.PERMISSION_DENIED,
			details: "not you",
		});
		expect(log).toEqual([]);
	});

	it("given to one service do not run for another", async () => {
		const log: string[] = [];
		const grpc = new GrpcServices(protobuf)
			.service(
				Echo,
				{ say: () => ({ text: "ok" }) },
				{
					interceptors: [
						async () => {
							throw new GrpcError(GrpcStatus.UNAUTHENTICATED, "echo only");
						},
					],
				},
			)
			.service(Admin, {
				ping: () => {
					log.push("admin.ping");
					return { text: "pong" };
				},
			});
		expect(status(await grpc.handle(call("/echo.Echo/Say")))).toBe(
			GrpcStatus.UNAUTHENTICATED,
		);
		expect(status(await grpc.handle(call("/echo.Admin/Ping")))).toBe(
			GrpcStatus.OK,
		);
		expect(log).toEqual(["admin.ping"]);
	});

	it("cannot run the method twice by calling next() twice", async () => {
		const log: string[] = [];
		const reported: unknown[] = [];
		const grpc = new GrpcServices(protobuf, {
			onError: (error) => reported.push(error),
		})
			.use(async (_context, next) => {
				await next();
				return next();
			})
			.service(Echo, {
				say: () => {
					log.push("method");
					return { text: "ok" };
				},
			});
		expect(status(await grpc.handle(call("/echo.Echo/Say")))).toBe(
			GrpcStatus.INTERNAL,
		);
		expect(log).toEqual(["method"]);
		expect(String(reported[0])).toContain("called next() more than once");
	});

	it("report an interceptor that forgets to return what next() gave it", async () => {
		const reported: unknown[] = [];
		const grpc = new GrpcServices(protobuf, {
			onError: (error) => reported.push(error),
		})
			.use(async (_context, next) => {
				await next();
				return undefined;
			})
			.service(Echo, { say: () => ({ text: "ok" }) });
		expect(status(await grpc.handle(call("/echo.Echo/Say")))).toBe(
			GrpcStatus.INTERNAL,
		);
		expect(String(reported[0])).toContain("instead of what next() gave it");
	});

	it("hand the method a value through a context key", async () => {
		const tenant = new GrpcContextKey<string | null>("none");
		let seen: string | null = "unset";
		const grpc = new GrpcServices(protobuf)
			.use(async (context, next) => {
				tenant.set(context, null);
				return next();
			})
			.service(Echo, {
				say: (_request, context) => {
					seen = tenant.get(context);
					return { text: "ok" };
				},
			});
		await grpc.handle(call("/echo.Echo/Say"));
		// A stored null is a value, not "nothing stored".
		expect(seen).toBeNull();
	});
});

interface User {
	id: number;
}

/** Accepts "good" for user 42, refuses anything else; records each call. */
function verifier(
	seen: { token: string; guard?: string }[],
): TokenVerifier<User> {
	return {
		async verify(token, guard) {
			seen.push({ token, guard });
			return token === "good"
				? { authenticated: true, user: { id: 42 } }
				: { authenticated: false };
		},
	};
}

describe("bearerAuth", () => {
	function protectedEcho(
		auth: ReturnType<typeof bearerAuth<User>>,
		log: string[],
	) {
		return new GrpcServices(protobuf, { onError: () => {} })
			.use(auth.interceptor)
			.service(Echo, {
				say: (_request, context) => {
					log.push(`user ${auth.user(context).id}`);
					return { text: "ok" };
				},
			});
	}

	it("lets a valid bearer token through and gives the method its user", async () => {
		const seen: { token: string; guard?: string }[] = [];
		const log: string[] = [];
		const grpc = protectedEcho(
			bearerAuth(verifier(seen), { guard: "jwt" }),
			log,
		);
		const reply = await grpc.handle(
			call("/echo.Echo/Say", { metadata: { authorization: "bearer good" } }),
		);
		expect(status(reply)).toBe(GrpcStatus.OK);
		expect(log).toEqual(["user 42"]);
		expect(seen).toEqual([{ token: "good", guard: "jwt" }]);
	});

	it.each([
		["no authorization", {}],
		["another scheme", { authorization: "Basic Z29vZDpwdw==" }],
		["an empty token", { authorization: "Bearer " }],
		["a refused token", { authorization: "Bearer bad" }],
	])(
		"answers UNAUTHENTICATED to %s, before the method runs",
		async (_, metadata) => {
			const log: string[] = [];
			const grpc = protectedEcho(bearerAuth(verifier([])), log);
			const reply = await grpc.handle(call("/echo.Echo/Say", { metadata }));
			expect(status(reply)).toBe(GrpcStatus.UNAUTHENTICATED);
			expect(log).toEqual([]);
		},
	);

	it("answers INTERNAL when the verifier itself breaks", async () => {
		const broken: TokenVerifier<User> = {
			async verify() {
				return { authenticated: false, strategyCrash: true };
			},
		};
		const log: string[] = [];
		const reply = await protectedEcho(bearerAuth(broken), log).handle(
			call("/echo.Echo/Say", { metadata: { authorization: "Bearer good" } }),
		);
		expect(status(reply)).toBe(GrpcStatus.INTERNAL);
		expect(log).toEqual([]);
	});

	it("fails closed in a method the interceptor did not protect", async () => {
		const auth = bearerAuth(verifier([]));
		const grpc = new GrpcServices(protobuf).service(Echo, {
			say: (_request, context) => ({ text: String(auth.user(context).id) }),
		});
		expect(status(await grpc.handle(call("/echo.Echo/Say")))).toBe(
			GrpcStatus.UNAUTHENTICATED,
		);
	});
});

describe("rateLimit", () => {
	function limiter(allowed: (key: string) => boolean, keys: string[]) {
		return {
			async checkRateLimit(key: string) {
				keys.push(key);
				return { allowed: allowed(key), resetSeconds: 30 };
			},
		};
	}

	it("counts by client IP and refuses over the limit before the method runs", async () => {
		const keys: string[] = [];
		const log: string[] = [];
		const grpc = serving(log).use(rateLimit(limiter(() => false, keys)));
		expect(await grpc.handle(call("/echo.Echo/Say"))).toEqual({
			code: GrpcStatus.RESOURCE_EXHAUSTED,
			details: "Too many requests — retry in 30s",
		});
		expect(keys).toEqual(["203.0.113.7"]);
		expect(log).toEqual([]);
	});

	it("counts under the key keyFor gives", async () => {
		const keys: string[] = [];
		const log: string[] = [];
		const grpc = serving(log).use(
			rateLimit(
				limiter(() => true, keys),
				{
					keyFor: (context) => `grpc:${context.method.name}`,
				},
			),
		);
		expect(status(await grpc.handle(call("/echo.Echo/Say")))).toBe(
			GrpcStatus.OK,
		);
		expect(keys).toEqual(["grpc:Say"]);
		expect(log).toEqual(["echo.say"]);
	});
});
