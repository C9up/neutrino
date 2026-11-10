import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	type GrpcCall,
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
		] as const) {
			expect(() => new GrpcServices(protobuf, { [key]: value })).toThrow(
				expect.objectContaining({ code: "E_NEUTRINO_INVALID_OPTION" }),
			);
		}
	});
});
