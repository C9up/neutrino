import { readFileSync } from "node:fs";
import { create, createFileRegistry, fromBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import {
	DuplicateTypeError,
	InvalidDescriptorError,
	InvalidMessageError,
	Protobuf,
	UnknownMethodError,
	UnknownTypeError,
} from "../src/index.js";

// Compiled from tests/fixtures/*.proto with
//   protoc --include_imports --descriptor_set_out=<name>.binpb <name>.proto
// (stale.binpb: `protoc -Istale --descriptor_set_out=stale.binpb stale/echo.proto`).
const fixture = (name: string): Uint8Array =>
	readFileSync(new URL(`./fixtures/${name}.binpb`, import.meta.url));

const echo = () => new Protobuf({ descriptorSets: [fixture("echo")] });

function varint(value: number): number[] {
	const out: number[] = [];
	let rest = value;
	while (rest > 127) {
		out.push((rest & 0x7f) | 0x80);
		rest >>>= 7;
	}
	out.push(rest);
	return out;
}

/** A `Tree` nested `depth` levels deep, through field 1 at every level. */
function nestedTree(depth: number): Uint8Array {
	let bytes: number[] = [];
	for (let i = 0; i < depth; i++)
		bytes = [0x0a, ...varint(bytes.length), ...bytes];
	return Uint8Array.from(bytes);
}

describe("Protobuf — codec", () => {
	it("round-trips a message found by its type name", () => {
		const protobuf = echo();
		const schema = protobuf.message("echo.SayRequest");
		const bytes = protobuf.encode(
			schema,
			create(schema, { text: "hi", times: 3 }),
		);
		const decoded = protobuf.decode(schema, bytes);
		expect(Reflect.get(decoded, "text")).toBe("hi");
		expect(Reflect.get(decoded, "times")).toBe(3);
	});

	it("keeps fields it does not know through decode and encode", () => {
		// SayReply has only field 1. Field 9 (a string) arrives from a newer
		// client: a server that drops it would silently lose data when it
		// forwards the message.
		const protobuf = echo();
		const schema = protobuf.message("echo.SayReply");
		const bytes = Uint8Array.from([0x0a, 0x01, 0x61, 0x4a, 0x02, 0x6e, 0x65]);
		expect(protobuf.encode(schema, protobuf.decode(schema, bytes))).toEqual(
			bytes,
		);
	});

	it("names an unknown type", () => {
		const error = (() => {
			try {
				echo().message("echo.Nope");
			} catch (caught) {
				return caught;
			}
		})();
		expect(error).toBeInstanceOf(UnknownTypeError);
		expect(error).toMatchObject({ code: "E_NEUTRINO_UNKNOWN_TYPE" });
	});
});

describe("Protobuf — hostile bytes", () => {
	const decodeError = (bytes: Uint8Array, type = "echo.SayRequest") => {
		const protobuf = echo();
		try {
			protobuf.decode(protobuf.message(type), bytes);
		} catch (caught) {
			return caught;
		}
		return undefined;
	};

	it("rejects truncated bytes, keeping the decoder's error as the cause", () => {
		const protobuf = echo();
		const schema = protobuf.message("echo.SayRequest");
		const bytes = protobuf.encode(schema, create(schema, { text: "hello" }));
		const error = decodeError(bytes.subarray(0, bytes.length - 1));
		expect(error).toBeInstanceOf(InvalidMessageError);
		expect(error).toMatchObject({
			code: "E_NEUTRINO_INVALID_MESSAGE",
			message: "Neutrino: the bytes are not a valid echo.SayRequest",
		});
		expect(error).toHaveProperty("cause");
	});

	it("rejects a string field that is not UTF-8", () => {
		expect(
			decodeError(Uint8Array.from([0x0a, 0x02, 0xff, 0xfe])),
		).toBeInstanceOf(InvalidMessageError);
	});

	it("rejects nesting past the recursion limit instead of exhausting the stack", () => {
		expect(decodeError(nestedTree(50), "echo.Tree")).toBeUndefined();
		expect(decodeError(nestedTree(5000), "echo.Tree")).toBeInstanceOf(
			InvalidMessageError,
		);
	});
});

describe("Protobuf — method lookup", () => {
	it("resolves a gRPC path to its method and schemas", () => {
		const method = echo().method("/echo.Echo/Say");
		expect(method.methodKind).toBe("unary");
		expect(method.input.typeName).toBe("echo.SayRequest");
		expect(method.output.typeName).toBe("echo.SayReply");
		expect(echo().method("/echo.Echo/Watch").methodKind).toBe(
			"server_streaming",
		);
	});

	it.each([
		"/echo.Echo/Nope",
		"/echo.Nope/Say",
		"echo.Echo/Say",
		"/echo.Echo",
		"/echo.Echo/Say/extra",
		"//Say",
		"",
	])("refuses %j", (path) => {
		expect(() => echo().method(path)).toThrow(UnknownMethodError);
	});
});

describe("Protobuf — sources", () => {
	it("refuses bytes that are not a descriptor set", () => {
		expect(
			() =>
				new Protobuf({ descriptorSets: [Uint8Array.from([1, 2, 3, 4, 5])] }),
		).toThrow(InvalidDescriptorError);
	});

	it("accepts the same imported file in two descriptor sets", () => {
		// echo.binpb and clock.binpb both embed shared/when.proto.
		const protobuf = new Protobuf({
			descriptorSets: [fixture("echo"), fixture("clock")],
		});
		expect(protobuf.message("shared.When").typeName).toBe("shared.When");
		expect(protobuf.message("clock.Tick").typeName).toBe("clock.Tick");
	});

	it("merges descriptor sets with generated file descriptors", () => {
		const file = createFileRegistry(
			fromBinary(FileDescriptorSetSchema, fixture("clock")),
		).getFile("clock.proto");
		if (!file) throw new Error("fixture clock.proto missing");
		const protobuf = new Protobuf({
			descriptorSets: [fixture("echo")],
			files: [file],
		});
		expect(protobuf.message("clock.Tick").typeName).toBe("clock.Tick");
		expect(protobuf.message("echo.SayReply").typeName).toBe("echo.SayReply");
	});

	it("refuses a type two sources declare differently, naming both", () => {
		expect(
			() =>
				new Protobuf({ descriptorSets: [fixture("echo"), fixture("stale")] }),
		).toThrow(
			new DuplicateTypeError(
				"echo.SayReply",
				"echo.proto (descriptor set #0)",
				"echo.proto (descriptor set #1)",
			),
		);
	});
});
