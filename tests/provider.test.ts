import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defineConfig, Protobuf } from "../src/index.js";
import NeutrinoProvider from "../src/NeutrinoProvider.js";
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

	async resolve(token: unknown): Promise<unknown> {
		if (!this.#instances.has(token)) {
			const factory = this.#factories.get(token);
			if (!factory) throw new Error(`nothing bound for ${String(token)}`);
			this.#instances.set(token, await factory());
		}
		return this.#instances.get(token);
	}
}

function boot(config: unknown) {
	const container = new Container();
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
	});

	it("fails at boot on a config that is not defineConfig's shape", async () => {
		const { provider } = boot({ descriptorSets: "proto/app.binpb" });
		await expect(provider.boot()).rejects.toThrow(/must export defineConfig/);
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
	});
});
