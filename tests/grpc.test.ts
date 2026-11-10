import { readFileSync } from "node:fs";
import { create, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it, vi } from "vitest";
import {
	type GrpcCall,
	type GrpcContext,
	GrpcError,
	type GrpcReply,
	GrpcServices,
	type GrpcServicesOptions,
	GrpcStatus,
	Protobuf,
	UnknownTypeError,
} from "../src/index.js";

const protobuf = new Protobuf({
	descriptorSets: [
		readFileSync(new URL("./fixtures/echo.binpb", import.meta.url)),
	],
});
const Echo = protobuf.service("echo.Echo");
const SayRequest = protobuf.message("echo.SayRequest");
const SayReply = protobuf.message("echo.SayReply");

function call(
	path: string,
	text: string,
	extra: Partial<GrpcCall> = {},
): GrpcCall {
	return {
		path,
		metadata: {},
		ip: "203.0.113.7",
		message: protobuf.encode(
			SayRequest,
			create(SayRequest, { text, times: 2 }),
		),
		...extra,
	};
}

function replyText(reply: GrpcReply): string {
	if (!("message" in reply)) {
		throw new Error(`expected a message, got status ${reply.code}`);
	}
	const text = Reflect.get(protobuf.decode(SayReply, reply.message), "text");
	return typeof text === "string" ? text : "";
}

const repeat = (request: unknown) => {
	const text = Reflect.get(Object(request), "text");
	const times = Reflect.get(Object(request), "times");
	return {
		text:
			typeof text === "string" && typeof times === "number"
				? text.repeat(times)
				: "",
	};
};

describe("GrpcServices — calls", () => {
	it("decodes the request, runs the method and encodes its reply", async () => {
		const grpc = new GrpcServices(protobuf).service(Echo, { say: repeat });
		expect(replyText(await grpc.handle(call("/echo.Echo/Say", "ab")))).toBe(
			"abab",
		);
	});

	it("gives the method the metadata, the client IP and its descriptor", async () => {
		let seen: GrpcContext | undefined;
		const grpc = new GrpcServices(protobuf).service(Echo, {
			say: (request, context) => {
				seen = context;
				return repeat(request);
			},
		});
		await grpc.handle(
			call("/echo.Echo/Say", "x", { metadata: { authorization: "Bearer t" } }),
		);
		expect(seen?.metadata.authorization).toBe("Bearer t");
		expect(seen?.ip).toBe("203.0.113.7");
		expect(seen?.method.name).toBe("Say");
	});

	it("keeps `this` for an implementation written as a class", async () => {
		class EchoImpl {
			readonly suffix = "!";
			say(request: unknown) {
				return { text: `${repeat(request).text}${this.suffix}` };
			}
		}
		const grpc = new GrpcServices(protobuf).service(Echo, new EchoImpl());
		expect(replyText(await grpc.handle(call("/echo.Echo/Say", "a")))).toBe(
			"aa!",
		);
	});

	it("answers the status of a GrpcError, with its message", async () => {
		const grpc = new GrpcServices(protobuf).service(Echo, {
			say: () => {
				throw new GrpcError(GrpcStatus.NOT_FOUND, "no such text");
			},
		});
		expect(await grpc.handle(call("/echo.Echo/Say", "a"))).toEqual({
			code: GrpcStatus.NOT_FOUND,
			details: "no such text",
		});
	});

	it("answers INTERNAL to any other error, reports it, and sends none of it", async () => {
		const reported: unknown[] = [];
		const failure = new Error("db password is hunter2");
		const grpc = new GrpcServices(protobuf, {
			onError: (error) => reported.push(error),
		}).service(Echo, {
			say: async () => {
				throw failure;
			},
		});
		expect(await grpc.handle(call("/echo.Echo/Say", "a"))).toEqual({
			code: GrpcStatus.INTERNAL,
			details: "Internal error",
		});
		expect(reported).toEqual([failure]);
	});

	it("reports an unexpected error on the console when given nowhere else", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		try {
			const failure = new Error("boom");
			const grpc = new GrpcServices(protobuf).service(Echo, {
				say: () => {
					throw failure;
				},
			});
			await grpc.handle(call("/echo.Echo/Say", "a"));
			expect(consoleError).toHaveBeenCalledWith(
				"[grpc] /echo.Echo/Say failed",
				failure,
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("answers INTERNAL to a method that returns no message", async () => {
		const reported: unknown[] = [];
		const grpc = new GrpcServices(protobuf, {
			onError: (error) => reported.push(error),
		}).service(Echo, { say: () => "abab" });
		expect(await grpc.handle(call("/echo.Echo/Say", "a"))).toEqual({
			code: GrpcStatus.INTERNAL,
			details: "Internal error",
		});
		expect(String(reported[0])).toContain(
			"returned string, not a echo.SayReply",
		);
	});

	it("answers INVALID_ARGUMENT to bytes that are not the input message", async () => {
		const grpc = new GrpcServices(protobuf).service(Echo, { say: repeat });
		const reply = await grpc.handle(
			call("/echo.Echo/Say", "", {
				message: Uint8Array.from([0x0a, 0x05, 0x61]),
			}),
		);
		expect(reply).toEqual({
			code: GrpcStatus.INVALID_ARGUMENT,
			details: "The request is not a valid echo.SayRequest",
		});
	});

	it("answers UNIMPLEMENTED to a method nobody serves", async () => {
		const grpc = new GrpcServices(protobuf).service(Echo, { say: repeat });
		expect(await grpc.handle(call("/echo.Echo/Watch", "a"))).toMatchObject({
			code: GrpcStatus.UNIMPLEMENTED,
		});
		expect(await grpc.handle(call("/other.Svc/Say", "a"))).toMatchObject({
			code: GrpcStatus.UNIMPLEMENTED,
		});
	});
});

describe("GrpcServices — unknown fields of a request", () => {
	// 4 MiB of field 15 = 0: two bytes each, two million fields a decoder
	// that keeps them turns into two million objects.
	const flood = new Uint8Array(4 * 1024 * 1024 - 16);
	for (let i = 0; i + 1 < flood.length; i += 2) flood[i] = 0x78;

	function capture(options: GrpcServicesOptions = {}) {
		const seen: unknown[] = [];
		const grpc = new GrpcServices(protobuf, options).service(Echo, {
			say: (request) => {
				seen.push(request.$unknown);
				return { text: "ok" };
			},
		});
		return { grpc, seen };
	}

	it("drops them by default, so a request holds no more than its known fields", async () => {
		const { grpc, seen } = capture();
		const reply = await grpc.handle(
			call("/echo.Echo/Say", "", { message: flood }),
		);
		expect("message" in reply).toBe(true);
		expect(seen).toEqual([undefined]);
	});

	it("keeps them when the app opts in", async () => {
		const { grpc, seen } = capture({ keepUnknownFields: true });
		await grpc.handle(
			call("/echo.Echo/Say", "", {
				message: Uint8Array.from([0x0a, 0x01, 0x61, 0x78, 0x00]),
			}),
		);
		expect(seen).toEqual([[{ no: 15, wireType: 0, data: Uint8Array.of(0) }]]);
	});
});

describe("GrpcServices — registration", () => {
	it("refuses an implementation key that is not a method of the service", () => {
		expect(() =>
			new GrpcServices(protobuf).service(Echo, { sya: repeat }),
		).toThrow(expect.objectContaining({ code: "E_NEUTRINO_UNKNOWN_METHOD" }));
	});

	it("refuses a streaming method instead of answering it wrong", () => {
		expect(() =>
			new GrpcServices(protobuf).service(Echo, { watch: repeat }),
		).toThrow(
			expect.objectContaining({ code: "E_NEUTRINO_STREAMING_UNSUPPORTED" }),
		);
	});

	it("refuses a method implemented by something that is not a function", () => {
		expect(() =>
			new GrpcServices(protobuf).service(Echo, { say: "nope" }),
		).toThrow(
			expect.objectContaining({ code: "E_NEUTRINO_INVALID_IMPLEMENTATION" }),
		);
	});

	it("does not mistake a class's own fields for misspelt methods", () => {
		class EchoImpl {
			readonly prefix = "> ";
			say(request: unknown) {
				return { text: `${this.prefix}${repeat(request).text}` };
			}
		}
		expect(() =>
			new GrpcServices(protobuf).service(Echo, new EchoImpl()),
		).not.toThrow();
	});

	it("refuses a service registered twice", () => {
		const grpc = new GrpcServices(protobuf).service(Echo, { say: repeat });
		expect(() => grpc.service(Echo, { say: repeat })).toThrow(
			expect.objectContaining({ code: "E_NEUTRINO_DUPLICATE_SERVICE" }),
		);
	});

	it("names an unknown service", () => {
		expect(() => protobuf.service("echo.Nope")).toThrow(UnknownTypeError);
	});
});

describe("GrpcServices — methods named like Object.prototype members", () => {
	// protobuf-es only escapes constructor/toString/toJSON/valueOf in a local
	// name, so these reach the implementation lookup as they are.
	const names = protobufWithMethods([
		"Say",
		"HasOwnProperty",
		"ToLocaleString",
		"__defineGetter__",
		"IsPrototypeOf",
	]);
	const Svc = names.service("p.Svc");
	const empty = { path: "", metadata: {}, ip: "x", message: new Uint8Array() };

	it("answers UNIMPLEMENTED to one the app left out, without reporting an error", async () => {
		const reported: unknown[] = [];
		const grpc = new GrpcServices(names, {
			onError: (error) => reported.push(error),
		}).service(Svc, { say: () => ({ text: "hi" }) });
		for (const method of [
			"HasOwnProperty",
			"ToLocaleString",
			"__defineGetter__",
			"IsPrototypeOf",
		]) {
			expect(await grpc.handle({ ...empty, path: `/p.Svc/${method}` })).toEqual(
				{
					code: GrpcStatus.UNIMPLEMENTED,
					details: `Method /p.Svc/${method} is not implemented`,
				},
			);
		}
		expect(reported).toEqual([]);
	});

	it("leaves out the members of Object.prototype for a class instance too", async () => {
		class SvcImpl {
			say() {
				return { text: "hi" };
			}
		}
		const grpc = new GrpcServices(names).service(Svc, new SvcImpl());
		expect(
			await grpc.handle({ ...empty, path: "/p.Svc/HasOwnProperty" }),
		).toMatchObject({ code: GrpcStatus.UNIMPLEMENTED });
	});

	it("serves one the app implements, on a class or inherited from its base", async () => {
		class Base {
			hasOwnProperty() {
				return { text: "own" };
			}
		}
		class SvcImpl extends Base {
			override toLocaleString() {
				return { text: "locale" };
			}
		}
		const grpc = new GrpcServices(names).service(Svc, new SvcImpl());
		const text = (reply: GrpcReply) =>
			"message" in reply
				? Reflect.get(
						names.decode(names.message("p.Req"), reply.message),
						"text",
					)
				: reply.code;
		expect(
			text(await grpc.handle({ ...empty, path: "/p.Svc/HasOwnProperty" })),
		).toBe("own");
		expect(
			text(await grpc.handle({ ...empty, path: "/p.Svc/ToLocaleString" })),
		).toBe("locale");
	});
});

function protobufWithMethods(methods: readonly string[]): Protobuf {
	const set = create(FileDescriptorSetSchema, {
		file: [
			{
				name: "p.proto",
				package: "p",
				syntax: "proto3",
				messageType: [
					{
						name: "Req",
						field: [
							{ name: "text", number: 1, type: 9, label: 1, jsonName: "text" },
						],
					},
				],
				service: [
					{
						name: "Svc",
						method: methods.map((name) => ({
							name,
							inputType: ".p.Req",
							outputType: ".p.Req",
						})),
					},
				],
			},
		],
	});
	return new Protobuf({
		descriptorSets: [toBinary(FileDescriptorSetSchema, set)],
	});
}
