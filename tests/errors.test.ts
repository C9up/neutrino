import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors, GrpcStatus } from "../src/index.js";

describe("errors", () => {
	it("are exported as one namespace of flare exceptions", () => {
		const error = new errors.E_NEUTRINO_INVALID_MESSAGE(["echo.SayRequest"]);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toMatchObject({
			code: "E_NEUTRINO_INVALID_MESSAGE",
			status: 400,
			message: "Neutrino: the bytes are not a valid echo.SayRequest",
		});
	});

	it("keep the gRPC status apart from the HTTP one", () => {
		const error = new errors.E_NEUTRINO_GRPC_STATUS(
			GrpcStatus.NOT_FOUND,
			"no such text",
		);
		expect(error).toMatchObject({
			code: "E_NEUTRINO_GRPC_STATUS",
			grpcStatus: GrpcStatus.NOT_FOUND,
			status: 500,
		});
	});
});
