import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	type GrpcCall,
	type GrpcReply,
	GrpcServices,
	type GrpcServicesOptions,
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

function call(text: string): GrpcCall {
	return {
		path: "/echo.Echo/Say",
		metadata: {},
		ip: "203.0.113.7",
		message: protobuf.encode(
			SayRequest,
			create(SayRequest, { text, times: 1 }),
		),
	};
}

/** Echoes the request text, `times` times over. */
function echo(options: GrpcServicesOptions, log: string[] = [], times = 1) {
	return new GrpcServices(protobuf, options)
		.use(async (_context, next) => {
			log.push("interceptor");
			return next();
		})
		.service(Echo, {
			say: (request) => {
				log.push("method");
				return { text: String(Reflect.get(request, "text")).repeat(times) };
			},
		});
}

describe("maxReceiveMessageLength", () => {
	it("answers RESOURCE_EXHAUSTED to a larger request, before any interceptor runs", async () => {
		const log: string[] = [];
		const request = call("x".repeat(3 * 1024 * 1024));
		const reply = await echo(
			{ maxReceiveMessageLength: 2 * 1024 * 1024 },
			log,
		).handle(request);
		expect(reply).toEqual({
			code: GrpcStatus.RESOURCE_EXHAUSTED,
			details: `Received message larger than max (${request.message.length} vs ${2 * 1024 * 1024})`,
		});
		expect(log).toEqual([]);
	});

	it("serves a request of exactly the limit", async () => {
		const request = call("x".repeat(100));
		const reply = await echo({
			maxReceiveMessageLength: request.message.length,
		}).handle(request);
		expect(reply).toHaveProperty("message");
	});

	it("defaults to 4 MiB, and -1 lifts it", async () => {
		const request = call("x".repeat(4 * 1024 * 1024));
		expect(await echo({}).handle(request)).toMatchObject({
			code: GrpcStatus.RESOURCE_EXHAUSTED,
		});
		expect(
			await echo({ maxReceiveMessageLength: -1 }).handle(request),
		).toHaveProperty("message");
	});
});

describe("maxSendMessageLength", () => {
	it("answers RESOURCE_EXHAUSTED instead of a larger reply", async () => {
		const reply = await echo({ maxSendMessageLength: 1000 }, [], 1000).handle(
			call("ab"),
		);
		expect(reply).toEqual({
			code: GrpcStatus.RESOURCE_EXHAUSTED,
			details: "Sent message larger than max (2003 vs. 1000)",
		});
	});

	it("is unlimited by default", async () => {
		expect(await echo({}).handle(call("x".repeat(5000)))).toHaveProperty(
			"message",
		);
	});
});

describe("limit options", () => {
	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-2,
		1.5,
		Number.MAX_SAFE_INTEGER + 2,
	])("refuses %s", (value) => {
		for (const key of [
			"maxReceiveMessageLength",
			"maxSendMessageLength",
			"maxInFlightRequestBytes",
		] as const) {
			expect(() => new GrpcServices(protobuf, { [key]: value })).toThrow(
				expect.objectContaining({ code: "E_NEUTRINO_INVALID_OPTION" }),
			);
		}
	});
});

describe("maxInFlightRequestBytes (bug 009)", () => {
	/** A service whose method waits until released, counting the calls it decoded. */
	function held(options: GrpcServicesOptions) {
		const decoded: string[] = [];
		const waiting: (() => void)[] = [];
		const services = new GrpcServices(protobuf, options).service(Echo, {
			say: async (request) => {
				decoded.push(String(Reflect.get(request, "text")).slice(0, 1));
				await new Promise<void>((resolve) => waiting.push(resolve));
				return { text: "ok" };
			},
		});
		const releaseAll = () => {
			for (const resolve of waiting.splice(0)) resolve();
		};
		return { services, decoded, releaseAll };
	}

	const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
	/** The status a reply carries, OK for a served one. */
	const status = (reply: GrpcReply): number =>
		"code" in reply ? reply.code : GrpcStatus.OK;
	const served = (reply: GrpcReply): boolean => "message" in reply;

	it("by default, decodes two maximal requests at once and refuses the rest before decoding", async () => {
		const { services, decoded, releaseAll } = held({});
		// The bug-009 shape: maximal requests whose decoded form is far larger
		// than their bytes, all in flight at once (a handler awaiting a DB).
		const big = call("x".repeat(4 * 1024 * 1024 - 64));
		const replies = Array.from({ length: 8 }, () => services.handle(big));
		await tick();
		expect(decoded).toHaveLength(2);
		releaseAll();
		const settled = await Promise.all(replies);
		const refused = settled.filter(
			(reply) => status(reply) === GrpcStatus.RESOURCE_EXHAUSTED,
		);
		expect(refused).toHaveLength(6);
		expect(refused[0]).toEqual({
			code: GrpcStatus.RESOURCE_EXHAUSTED,
			details: `Too many request bytes in flight (${8 * 1024 * 1024} max)`,
		});
		expect(settled.filter(served)).toHaveLength(2);
	});

	it("frees the budget when the method settles, so later calls are served", async () => {
		const { services, decoded, releaseAll } = held({
			maxInFlightRequestBytes: 64,
		});
		const first = services.handle(call("a".repeat(40)));
		await tick();
		const refused = await services.handle(call("b".repeat(40)));
		expect(status(refused)).toBe(GrpcStatus.RESOURCE_EXHAUSTED);
		releaseAll();
		expect(served(await first)).toBe(true);
		const later = services.handle(call("c".repeat(40)));
		await tick();
		releaseAll();
		expect(served(await later)).toBe(true);
		expect(decoded).toEqual(["a", "c"]);
	});

	it("keeps a call's bytes counted after its deadline, until its method stops", async () => {
		const { services, decoded, releaseAll } = held({
			maxInFlightRequestBytes: 64,
		});
		const late = {
			...call("a".repeat(40)),
			metadata: { "grpc-timeout": "10m" },
		};
		expect(status(await services.handle(late))).toBe(
			GrpcStatus.DEADLINE_EXCEEDED,
		);
		// Answered, but the method still holds its decoded request.
		expect(status(await services.handle(call("b".repeat(40))))).toBe(
			GrpcStatus.RESOURCE_EXHAUSTED,
		);
		releaseAll();
		await tick();
		const next = services.handle(call("c".repeat(40)));
		await tick();
		releaseAll();
		expect(served(await next)).toBe(true);
		expect(decoded).toEqual(["a", "c"]);
	});

	it("always admits a call when nothing is in flight", async () => {
		const { services, releaseAll } = held({ maxInFlightRequestBytes: 8 });
		const alone = services.handle(call("a".repeat(40)));
		await tick();
		releaseAll();
		expect(served(await alone)).toBe(true);
	});

	it("-1 lifts the bound", async () => {
		const { services, decoded, releaseAll } = held({
			maxInFlightRequestBytes: -1,
		});
		const big = call("x".repeat(4 * 1024 * 1024 - 64));
		const replies = Array.from({ length: 4 }, () => services.handle(big));
		await tick();
		expect(decoded).toHaveLength(4);
		releaseAll();
		await Promise.all(replies);
	});
});
