import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	type GrpcCall,
	type GrpcContext,
	GrpcError,
	GrpcServices,
	GrpcStatus,
	Protobuf,
} from "../src/index.js";

const protobuf = new Protobuf({
	descriptorSets: [
		readFileSync(new URL("./fixtures/echo.binpb", import.meta.url)),
	],
});
const Echo = protobuf.service("echo.Echo");
const SayRequest = protobuf.message("echo.SayRequest");
const request = protobuf.encode(
	SayRequest,
	create(SayRequest, { text: "a", times: 1 }),
);

function call(extra: Partial<GrpcCall> = {}): GrpcCall {
	return {
		path: "/echo.Echo/Say",
		metadata: {},
		ip: "203.0.113.7",
		message: request,
		...extra,
	};
}

/** A method that never answers, recording the context it was called with. */
function hanging(seen: GrpcContext[], reported: unknown[] = []) {
	return new GrpcServices(protobuf, {
		onError: (error) => reported.push(error),
	}).service(Echo, {
		say: (_request, context) => {
			seen.push(context);
			return new Promise<{ text: string }>(() => {});
		},
	});
}

describe("grpc-timeout", () => {
	it("answers DEADLINE_EXCEEDED when the deadline passes, and aborts the method's signal", async () => {
		const seen: GrpcContext[] = [];
		const started = performance.now();
		const reply = await hanging(seen).handle(
			call({ metadata: { "grpc-timeout": "50m" } }),
		);
		const elapsed = performance.now() - started;
		expect(reply).toEqual({
			code: GrpcStatus.DEADLINE_EXCEEDED,
			details: "Deadline exceeded",
		});
		expect(elapsed).toBeGreaterThanOrEqual(45);
		expect(elapsed).toBeLessThan(1000);
		const signal = seen[0]?.signal;
		expect(signal?.aborted).toBe(true);
		expect(signal?.reason).toBeInstanceOf(GrpcError);
		expect(signal?.reason).toMatchObject({
			status: GrpcStatus.DEADLINE_EXCEEDED,
		});
	});

	it("tells the method its deadline, and Infinity when the client set none", async () => {
		const seen: GrpcContext[] = [];
		const grpc = new GrpcServices(protobuf).service(Echo, {
			say: (_request, context) => {
				seen.push(context);
				return { text: "ok" };
			},
		});
		const before = Date.now();
		await grpc.handle(call({ metadata: { "grpc-timeout": "2S" } }));
		await grpc.handle(call());
		expect(seen[0]?.deadline).toBeGreaterThanOrEqual(before + 2000);
		expect(seen[0]?.deadline).toBeLessThan(before + 3000);
		expect(seen[0]?.signal.aborted).toBe(false);
		expect(seen[1]?.deadline).toBe(Number.POSITIVE_INFINITY);
	});

	it.each(["5", "S", "5s", "1.5S", "-1S", "123456789S", " 5S", "5 S", "x5S"])(
		"answers INTERNAL to a malformed value (%j), before the method runs",
		async (value) => {
			const seen: GrpcContext[] = [];
			expect(
				await hanging(seen).handle(
					call({ metadata: { "grpc-timeout": value } }),
				),
			).toEqual({
				code: GrpcStatus.INTERNAL,
				details: `Invalid grpc-timeout value "${value}"`,
			});
			expect(seen).toEqual([]);
		},
	);

	it("answers a deadline already passed without running the method", async () => {
		const seen: GrpcContext[] = [];
		expect(
			await hanging(seen).handle(call({ metadata: { "grpc-timeout": "0m" } })),
		).toMatchObject({ code: GrpcStatus.DEADLINE_EXCEEDED });
		expect(seen).toEqual([]);
	});

	it("rounds a sub-millisecond timeout up, instead of to an expired deadline", async () => {
		const grpc = new GrpcServices(protobuf).service(Echo, {
			say: () => ({ text: "ok" }),
		});
		expect(
			await grpc.handle(call({ metadata: { "grpc-timeout": "999u" } })),
		).toHaveProperty("message");
	});

	it("serves a call whose timeout is past what a timer can hold", async () => {
		// 99999999 hours: a timer armed with it would overflow and fire at once.
		const grpc = new GrpcServices(protobuf).service(Echo, {
			say: async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return { text: "ok" };
			},
		});
		expect(
			await grpc.handle(call({ metadata: { "grpc-timeout": "99999999H" } })),
		).toHaveProperty("message");
	});

	it("does not report what the method throws once the call is answered", async () => {
		const reported: unknown[] = [];
		const grpc = new GrpcServices(protobuf, {
			onError: (error) => reported.push(error),
		}).service(Echo, {
			say: (_request, context) =>
				new Promise<{ text: string }>((_resolve, reject) => {
					context.signal.addEventListener("abort", () =>
						reject(new Error("query aborted")),
					);
				}),
		});
		await grpc.handle(call({ metadata: { "grpc-timeout": "20m" } }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(reported).toEqual([]);
	});
});

describe("after the deadline", () => {
	it("does not decode nor run the method when an interceptor lets the call through too late", async () => {
		const ran: string[] = [];
		const grpc = new GrpcServices(protobuf)
			.use(async (_context, next) => {
				await new Promise((resolve) => setTimeout(resolve, 40));
				ran.push("interceptor");
				return next().catch((error: unknown) => {
					ran.push(String(error));
					throw error;
				});
			})
			.service(Echo, {
				say: () => {
					ran.push("method");
					return { text: "ok" };
				},
			});
		expect(
			await grpc.handle(call({ metadata: { "grpc-timeout": "10m" } })),
		).toMatchObject({ code: GrpcStatus.DEADLINE_EXCEEDED });
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(ran).toEqual(["interceptor", "GrpcError: Deadline exceeded"]);
	});
});

describe("cancellation by the host", () => {
	it("answers CANCELLED and aborts the method's signal when the host's signal aborts", async () => {
		const seen: GrpcContext[] = [];
		const host = new AbortController();
		const pending = hanging(seen).handle(call({ signal: host.signal }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		host.abort();
		expect(await pending).toEqual({
			code: GrpcStatus.CANCELLED,
			details: "Cancelled",
		});
		expect(seen[0]?.signal.aborted).toBe(true);
		expect(seen[0]?.signal.reason).toMatchObject({
			status: GrpcStatus.CANCELLED,
		});
	});

	it("does not run the method of a call cancelled before it started", async () => {
		const seen: GrpcContext[] = [];
		const host = new AbortController();
		host.abort();
		expect(
			await hanging(seen).handle(call({ signal: host.signal })),
		).toMatchObject({ code: GrpcStatus.CANCELLED });
		expect(seen).toEqual([]);
	});

	it("leaves the host's signal alone once the call is answered", async () => {
		const host = new AbortController();
		const grpc = new GrpcServices(protobuf).service(Echo, {
			say: () => ({ text: "ok" }),
		});
		let seen: GrpcContext | undefined;
		grpc.use(async (context, next) => {
			seen = context;
			return next();
		});
		await grpc.handle(call({ signal: host.signal }));
		host.abort();
		expect(seen?.signal.aborted).toBe(false);
	});
});
