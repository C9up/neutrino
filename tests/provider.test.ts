import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	defineConfig,
	type GrpcCall,
	type GrpcReply,
	GrpcServices,
	Protobuf,
} from "../src/index.js";
import NeutrinoProvider from "../src/NeutrinoProvider.js";
import grpc, { getGrpc } from "../src/services/grpc.js";
import protobuf, { getProtobuf } from "../src/services/main.js";

const fixturePath = (name: string): string =>
	fileURLToPath(new URL(`./fixtures/${name}.binpb`, import.meta.url));

/** The two members the provider uses, with singleton semantics. */
class Container {
	readonly #factories = new Map<unknown, () => unknown>();
	readonly #instances = new Map<unknown, unknown>();

	singleton(token: unknown, factory: () => unknown): void {
		this.#factories.set(token, factory);
	}

	has(token: unknown): boolean {
		return this.#factories.has(token);
	}

	async resolve(token: unknown): Promise<unknown> {
		if (!this.#instances.has(token)) {
			const factory = this.#factories.get(token);
			if (!factory) throw new Error(`nothing bound for ${String(token)}`);
			this.#instances.set(token, await factory());
		}
		return this.#instances.get(token);
	}
}

function boot(config: unknown, server?: unknown) {
	const container = new Container();
	if (server !== undefined) container.singleton("server", () => server);
	const provider = new NeutrinoProvider({
		container,
		config: { get: (key) => (key === "protobuf" ? config : undefined) },
	});
	provider.register();
	return { container, provider };
}

let current: NeutrinoProvider | undefined;
afterEach(async () => {
	await current?.shutdown();
	current = undefined;
});

describe("NeutrinoProvider", () => {
	it("loads the configured descriptor sets at boot and binds one instance", async () => {
		const { container, provider } = boot(
			defineConfig({ descriptorSets: [fixturePath("echo")] }),
		);
		current = provider;
		await provider.boot();

		const byClass = await container.resolve(Protobuf);
		expect(byClass).toBeInstanceOf(Protobuf);
		expect(await container.resolve("protobuf")).toBe(byClass);
		expect(await container.resolve("neutrino.protobuf")).toBe(byClass);
		expect(getProtobuf()).toBe(byClass);
		expect(protobuf.method("/echo.Echo/Say").input.typeName).toBe(
			"echo.SayRequest",
		);
	});

	it("fails at boot, not on first use, when a descriptor file is missing", async () => {
		const { provider } = boot(
			defineConfig({ descriptorSets: [fixturePath("absent")] }),
		);
		await expect(provider.boot()).rejects.toThrow(/ENOENT/);
	});

	it("fails at boot when two schemas disagree", async () => {
		const { provider } = boot(
			defineConfig({
				descriptorSets: [fixturePath("echo"), fixturePath("stale")],
			}),
		);
		await expect(provider.boot()).rejects.toMatchObject({
			code: "E_NEUTRINO_DUPLICATE_TYPE",
		});
	});

	it("fails at boot without config/protobuf.ts", async () => {
		const { provider } = boot(undefined);
		await expect(provider.boot()).rejects.toThrow(
			"[protobuf] missing config/protobuf.ts",
		);
		await expect(provider.boot()).rejects.toMatchObject({
			code: "E_NEUTRINO_MISSING_CONFIG",
		});
	});

	it("unseats the instance on shutdown", async () => {
		const { provider } = boot(
			defineConfig({ descriptorSets: [fixturePath("echo")] }),
		);
		await provider.boot();
		await provider.shutdown();
		expect(getProtobuf()).toBeUndefined();
		expect(() => protobuf.message("echo.SayReply")).toThrow(
			/accessed before initialization/,
		);
		expect(() => protobuf.message("echo.SayReply")).toThrow(
			expect.objectContaining({ code: "E_NEUTRINO_NOT_BOOTED" }),
		);
	});

	it("fails at boot on a config that is not defineConfig's shape", async () => {
		const { provider } = boot({ descriptorSets: "proto/app.binpb" });
		await expect(provider.boot()).rejects.toThrow(/must export defineConfig/);
		await expect(provider.boot()).rejects.toMatchObject({
			code: "E_NEUTRINO_INVALID_CONFIG",
		});
	});
});

describe("NeutrinoProvider bindings", () => {
	it("refuses a Protobuf token rebound to something else", async () => {
		const { container, provider } = boot(
			defineConfig({ descriptorSets: [fixturePath("echo")] }),
		);
		container.singleton(Protobuf, () => ({}));
		await expect(provider.boot()).rejects.toMatchObject({
			code: "E_NEUTRINO_INVALID_BINDING",
		});
	});
});

describe("services/grpc", () => {
	it("does not look thenable while unseated, and says what is missing on use", () => {
		expect(getGrpc()).toBeUndefined();
		expect(Reflect.get(grpc, "then")).toBeUndefined();
		expect(() => Reflect.get(grpc, "handle")).toThrow(
			"[grpc] accessed before initialization",
		);
		expect(() => Reflect.get(grpc, "handle")).toThrow(
			expect.objectContaining({ code: "E_NEUTRINO_NOT_BOOTED" }),
		);
	});
});

describe("services/main", () => {
	it("does not look thenable while unseated, so importing it never throws", () => {
		// A module loader reads `then` off what it imports; throwing there
		// would crash the import, far from any real use.
		expect(getProtobuf()).toBeUndefined();
		expect(Reflect.get(protobuf, "then")).toBeUndefined();
	});
});

describe("defineConfig", () => {
	it("refuses a config that loads no schema", () => {
		expect(() => defineConfig({})).toThrow(/declares no schema/);
		expect(() => defineConfig({})).toThrow(
			expect.objectContaining({ code: "E_NEUTRINO_INVALID_CONFIG" }),
		);
	});
});

describe("NeutrinoProvider — gRPC", () => {
	const config = () => defineConfig({ descriptorSets: [fixturePath("echo")] });

	it("hands the dispatcher to the host's server at boot", async () => {
		const handlers: ((call: GrpcCall) => Promise<GrpcReply>)[] = [];
		const server = {
			grpc: (handler: (call: GrpcCall) => Promise<GrpcReply>) =>
				handlers.push(handler),
		};
		const { container, provider } = boot(config(), server);
		current = provider;
		await provider.boot();

		const services = await container.resolve(GrpcServices);
		expect(services).toBeInstanceOf(GrpcServices);
		expect(await container.resolve("grpc")).toBe(services);
		expect(getGrpc()).toBe(services);
		expect(handlers).toHaveLength(1);

		// A service registered afterwards — from a preload — is served by the
		// handler the server already holds.
		grpc.service(protobuf.service("echo.Echo"), {
			say: () => ({ text: "hi" }),
		});
		const reply = await handlers[0]?.({
			path: "/echo.Echo/Say",
			metadata: {},
			ip: "127.0.0.1",
			message: new Uint8Array(),
		});
		expect(reply).toHaveProperty("message");
	});

	it("applies the gRPC options of the config, and hands the message limits to the server", async () => {
		const received: unknown[][] = [];
		const server = {
			grpc: (...args: unknown[]) => received.push(args),
		};
		const { container, provider } = boot(
			defineConfig({
				descriptorSets: [fixturePath("echo")],
				grpc: { maxReceiveMessageLength: 4, maxSendMessageLength: 1024 },
			}),
			server,
		);
		current = provider;
		await provider.boot();
		expect(received[0]?.[1]).toEqual({
			maxReceiveMessageLength: 4,
			maxSendMessageLength: 1024,
		});
		const services = await container.resolve(GrpcServices);
		if (!(services instanceof GrpcServices)) throw new Error("no GrpcServices");
		services.service(protobuf.service("echo.Echo"), {
			say: () => ({ text: "hi" }),
		});
		expect(
			await services.handle({
				path: "/echo.Echo/Say",
				metadata: {},
				ip: "127.0.0.1",
				message: new Uint8Array(5),
			}),
		).toMatchObject({ code: 8 });
	});

	it("fails at boot on a gRPC limit that is not a byte count", async () => {
		const { provider } = boot(
			defineConfig({
				descriptorSets: [fixturePath("echo")],
				grpc: { maxReceiveMessageLength: Number.NaN },
			}),
			{ grpc: () => {} },
		);
		await expect(provider.boot()).rejects.toMatchObject({
			code: "E_NEUTRINO_INVALID_OPTION",
		});
	});

	it("fails at boot on an in-flight bound that is not a byte count", async () => {
		const { provider } = boot(
			defineConfig({
				descriptorSets: [fixturePath("echo")],
				grpc: { maxInFlightRequestBytes: -2 },
			}),
			{ grpc: () => {} },
		);
		await expect(provider.boot()).rejects.toMatchObject({
			code: "E_NEUTRINO_INVALID_OPTION",
		});
	});

	it("fails at boot on gRPC options that are not an object", async () => {
		const { provider } = boot({
			descriptorSets: [fixturePath("echo")],
			grpc: "fast",
		});
		await expect(provider.boot()).rejects.toThrow(/must export defineConfig/);
	});

	it("refuses a server that cannot serve gRPC instead of ignoring it", async () => {
		const { provider } = boot(config(), { use: () => {} });
		await expect(provider.boot()).rejects.toMatchObject({
			code: "E_NEUTRINO_GRPC_UNSUPPORTED",
		});
	});

	it("serves nothing on a host with no server", async () => {
		const { provider } = boot(config());
		current = provider;
		await expect(provider.boot()).resolves.toBeUndefined();
	});
});
