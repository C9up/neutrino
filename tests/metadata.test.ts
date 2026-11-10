import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	bearerAuth,
	type GrpcCall,
	type GrpcContext,
	GrpcMetadata,
	type GrpcReply,
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

function call(metadata: GrpcCall["metadata"]): GrpcCall {
	return {
		path: "/echo.Echo/Say",
		metadata,
		ip: "203.0.113.7",
		message: request,
	};
}

/** Serve one call and hand back the context the method saw. */
async function contextOf(
	metadata: GrpcCall["metadata"],
): Promise<{ reply: GrpcReply; context: GrpcContext | undefined }> {
	let context: GrpcContext | undefined;
	const grpc = new GrpcServices(protobuf, {
		onError: (error) => {
			throw error;
		},
	}).service(Echo, {
		say: (_request, seen) => {
			context = seen;
			return { text: "ok" };
		},
	});
	return { reply: await grpc.handle(call(metadata)), context };
}

describe("GrpcMetadata", () => {
	it("keeps every value of a repeated key, in order", async () => {
		const { context } = await contextOf({ "x-dup": ["a", "b"] });
		expect(context?.metadata.get("x-dup")).toEqual(["a", "b"]);
		expect(context?.metadata.getMap()["x-dup"]).toBe("a");
	});

	it("decodes -bin values to bytes, padded or not, splitting comma-separated ones", async () => {
		const { context } = await contextOf({
			"trace-bin": "AAEC/w==",
			"ids-bin": ["AQ, Ag", "Aw"],
		});
		expect(context?.metadata.get("trace-bin")).toEqual([
			Uint8Array.of(0, 1, 2, 0xff),
		]);
		expect(context?.metadata.get("ids-bin")).toEqual([
			Uint8Array.of(1),
			Uint8Array.of(2),
			Uint8Array.of(3),
		]);
	});

	it("answers INTERNAL to a -bin value that is not base64, before the method runs", async () => {
		for (const value of ["AAEC*w==", "A", "AA=A", "AAEC/w==="]) {
			const { reply, context } = await contextOf({ "trace-bin": value });
			expect(reply).toEqual({
				code: GrpcStatus.INTERNAL,
				details: 'Invalid binary metadata "trace-bin"',
			});
			expect(context).toBeUndefined();
		}
	});

	it("hides the transport headers and the pseudo-headers from the application", async () => {
		const { context } = await contextOf({
			":path": "/echo.Echo/Say",
			"content-type": "application/grpc",
			te: "trailers",
			"grpc-timeout": "5S",
			"grpc-encoding": "identity",
			"grpc-accept-encoding": "gzip",
			"accept-encoding": "gzip",
			"x-kept": "yes",
		});
		expect(context?.metadata.getMap()).toEqual({ "x-kept": "yes" });
	});

	it("reads keys case-insensitively", async () => {
		const { context } = await contextOf({ "X-Request-Id": "r1" });
		expect(context?.metadata.get("x-request-id")).toEqual(["r1"]);
		expect(context?.metadata.get("X-REQUEST-ID")).toEqual(["r1"]);
	});

	it("answers an empty list for a key the call does not carry", async () => {
		const { context } = await contextOf({});
		expect(context?.metadata.get("authorization")).toEqual([]);
	});

	it("gives copies, so a method cannot change what the next reader sees", () => {
		const metadata = new GrpcMetadata({ "x-a": "1", "t-bin": "AQ==" });
		const values = metadata.get("x-a");
		values.push("2");
		const [bytes] = metadata.get("t-bin");
		if (bytes instanceof Uint8Array) bytes[0] = 9;
		expect(metadata.get("x-a")).toEqual(["1"]);
		expect(metadata.get("t-bin")).toEqual([Uint8Array.of(1)]);
	});

	it("keeps a key named like an Object.prototype member as plain data", () => {
		// An own "__proto__" key, as a header can be named.
		const metadata = new GrpcMetadata(
			Object.fromEntries([
				["__proto__", "p"],
				["constructor", "c"],
			]),
		);
		const map = metadata.getMap();
		expect(Object.getPrototypeOf(map)).toBeNull();
		expect(Object.keys(map)).toEqual(["__proto__", "constructor"]);
		expect(map.constructor).toBe("c");
		expect(metadata.get("__proto__")).toEqual(["p"]);
		expect(metadata.get("toString")).toEqual([]);
	});
});

describe("bearerAuth over metadata", () => {
	const verifier = {
		async verify(token: string) {
			return token === "good"
				? { authenticated: true, user: { id: "42" } }
				: { authenticated: false };
		},
	};

	function guarded(log: string[]) {
		return new GrpcServices(protobuf)
			.use(bearerAuth(verifier).interceptor)
			.service(Echo, {
				say: () => {
					log.push("ran");
					return { text: "ok" };
				},
			});
	}

	it("refuses a call carrying two authorization values, even if one is valid", async () => {
		const log: string[] = [];
		const reply = await guarded(log).handle(
			call({ authorization: ["Bearer good", "Bearer forged"] }),
		);
		expect(reply).toMatchObject({ code: GrpcStatus.UNAUTHENTICATED });
		expect(log).toEqual([]);
	});

	it("accepts a single value given as a one-element list", async () => {
		const log: string[] = [];
		const reply = await guarded(log).handle(
			call({ authorization: ["Bearer good"] }),
		);
		expect("message" in reply).toBe(true);
		expect(log).toEqual(["ran"]);
	});
});
